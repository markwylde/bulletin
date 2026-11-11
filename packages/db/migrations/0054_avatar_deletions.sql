-- 0054: persistent avatar-object deletion work (ADR 0019).
--
-- A failed object deletion must not leave removed personal content publicly reachable. The
-- avatar row is cleared immediately and its old URL stops resolving; these rows are retried by
-- the worker and reconciled against the bucket.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.avatar_deletions (
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  avatar_hash text NOT NULL CHECK (avatar_hash ~ '^[0-9a-f]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, avatar_hash)
);

CREATE INDEX IF NOT EXISTS avatar_deletions_created_idx
  ON core.avatar_deletions (created_at);

RESET ROLE;

GRANT SELECT, INSERT, DELETE ON core.avatar_deletions TO user_api, staff_api;
GRANT SELECT, UPDATE, DELETE ON core.avatar_deletions TO workers;
