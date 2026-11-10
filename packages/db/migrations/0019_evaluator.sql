-- 0019: evaluator support (ADR 0005, 0006, 0018).
-- Forum passwords are a forum setting; the session grants themselves live in
-- `core.session_grants` from migration 0008. Unlock throttling is durable so it survives a
-- process restart and applies across API replicas.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.forums
  ADD COLUMN IF NOT EXISTS password_hash text;

CREATE TABLE IF NOT EXISTS core.forum_unlock_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id bigint NOT NULL REFERENCES core.sessions (id) ON DELETE CASCADE,
  forum_id bigint NOT NULL REFERENCES core.forums (id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS forum_unlock_attempts_window_idx
  ON core.forum_unlock_attempts (session_id, forum_id, attempted_at DESC);

INSERT INTO core.cache_tags (tag, version)
VALUES ('perm', 0)
ON CONFLICT (tag) DO NOTHING;

RESET ROLE;

GRANT SELECT ON core.forum_unlock_attempts TO staff_api, workers;
GRANT SELECT, INSERT, DELETE ON core.forum_unlock_attempts TO user_api;
GRANT USAGE, SELECT ON SEQUENCE core.forum_unlock_attempts_id_seq TO user_api;
