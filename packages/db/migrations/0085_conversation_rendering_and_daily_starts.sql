-- 0085: conversation message rendering versions and a durable daily start counter
-- (conversations review findings; ADR 0007, 0010, 0012).
--
-- Messages are personal content but still flow through the sanitiser pipeline. Persisting the
-- versions lets the read path re-sanitise stale HTML immediately and the worker re-render it.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.conversation_messages
  ADD COLUMN IF NOT EXISTS render_version integer NOT NULL DEFAULT 3000000;

ALTER TABLE core.conversation_messages
  ADD COLUMN IF NOT EXISTS sanitiser_version integer NOT NULL DEFAULT 1;

ALTER TABLE core.conversation_messages
  DROP CONSTRAINT IF EXISTS conversation_messages_render_version_check;
ALTER TABLE core.conversation_messages
  ADD CONSTRAINT conversation_messages_render_version_check CHECK (render_version > 0);

ALTER TABLE core.conversation_messages
  DROP CONSTRAINT IF EXISTS conversation_messages_sanitiser_version_check;
ALTER TABLE core.conversation_messages
  ADD CONSTRAINT conversation_messages_sanitiser_version_check CHECK (sanitiser_version > 0);

CREATE INDEX IF NOT EXISTS conversation_messages_stale_render_idx
  ON core.conversation_messages (render_version, sanitiser_version, id);

-- The daily start limit must survive conversation cleanup: deleting content must not restore
-- an allowance (review finding P2).
CREATE TABLE IF NOT EXISTS core.conversation_daily_starts (
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  day date NOT NULL,
  starts integer NOT NULL DEFAULT 0 CHECK (starts >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, day)
);

RESET ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.conversation_daily_starts TO user_api;
