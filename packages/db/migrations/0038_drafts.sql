-- 0038: server-side draft autosave (ADR 0007, 0012).
--
-- Drafts are personal content: one row per member and editor context, delivered only through
-- member-authenticated endpoints/overlays. The maintenance sweep deletes rows untouched for
-- 30 days.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.drafts (
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  context_key text NOT NULL CHECK (context_key ~ '^[a-z0-9][a-z0-9:._-]{0,119}$'),
  body_md text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, context_key)
);

CREATE INDEX IF NOT EXISTS drafts_updated_idx ON core.drafts (updated_at);

RESET ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.drafts TO user_api, workers;
