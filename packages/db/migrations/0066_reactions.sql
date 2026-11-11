-- 0066: reactions and the per-post reaction summary (ADR 0001, 0005, 0006).
--
-- Staff define the reaction set; a member has at most one reaction per post. Totals live in a
-- denormalised `reaction_summary` so the post-body fragment never rebuilds when someone
-- reacts: only the `post:{id}:reactions` fragment does (ADR 0006).

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.reactions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Stable identity used by the seed and the staff manager; never shown to members.
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- An emoji today; the column keeps the staff-managed icon out of the template.
  icon text NOT NULL CHECK (char_length(btrim(icon)) BETWEEN 1 AND 32),
  -- A shipped catalog key, so every reaction label is translated in en, es and fr (ADR 0013).
  label_key text NOT NULL CHECK (label_key ~ '^reaction\.label\.[a-z][a-z0-9_]*$'),
  weight smallint NOT NULL DEFAULT 0 CHECK (weight IN (-1, 0, 1)),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reactions_position_idx ON core.reactions (position, id);

CREATE TABLE IF NOT EXISTS core.post_reactions (
  post_id bigint NOT NULL REFERENCES core.posts (id) ON DELETE CASCADE,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  -- Deleting a reaction in use would silently rewrite history; staff disable it instead.
  reaction_id bigint NOT NULL REFERENCES core.reactions (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, member_id)
);

CREATE INDEX IF NOT EXISTS post_reactions_tally_idx
  ON core.post_reactions (post_id, reaction_id, created_at DESC);

CREATE INDEX IF NOT EXISTS post_reactions_member_idx
  ON core.post_reactions (member_id, post_id);

-- `{ "<reaction id>": <count> }`, recomputed in the reaction transaction under the post lock.
ALTER TABLE core.posts
  ADD COLUMN IF NOT EXISTS reaction_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

RESET ROLE;

-- Reading roles render the bar; staff manage the set; only user-api writes reactions.
GRANT SELECT ON core.reactions, core.post_reactions TO user_app, user_api, staff_api, workers;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.reactions TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.reactions_id_seq TO staff_api;

GRANT INSERT, UPDATE, DELETE ON core.post_reactions TO user_api;

-- The staff-managed reaction set is a new ACP surface (ADR 0005).
INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, 'acp.reactions', to_jsonb(true)
FROM core.groups g
WHERE g.key = 'administrators'
ON CONFLICT (group_id, key) DO NOTHING;
