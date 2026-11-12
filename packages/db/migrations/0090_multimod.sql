-- 0090: multi-moderation definitions (moderation 3.3/3.4).
--
-- A definition is a named list of steps available in chosen forums. Steps are validated by
-- the domain before they are stored; the JSONB keeps the ordered steps as one atomic value.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.multimod_actions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  forum_ids bigint[] NOT NULL DEFAULT '{}',
  steps jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array'),
  created_by bigint REFERENCES core.members (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT multimod_actions_name_key UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS multimod_actions_forums_idx
  ON core.multimod_actions USING gin (forum_ids);

RESET ROLE;

GRANT SELECT ON core.multimod_actions TO user_app, user_api, staff_api;
GRANT INSERT, UPDATE, DELETE ON core.multimod_actions TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.multimod_actions_id_seq TO staff_api;
