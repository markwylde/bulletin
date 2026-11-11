-- 0077: post-count ranks, custom titles and automatic badge rules (member-profiles 5.1-5.4).

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS custom_title text;

ALTER TABLE core.members DROP CONSTRAINT IF EXISTS members_custom_title_length_check;

ALTER TABLE core.members
  ADD CONSTRAINT members_custom_title_length_check
  CHECK (custom_title IS NULL OR char_length(custom_title) <= 100);

CREATE TABLE IF NOT EXISTS core.ranks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  min_posts integer NOT NULL UNIQUE CHECK (min_posts >= 0),
  title_labels jsonb NOT NULL CHECK (jsonb_typeof(title_labels) = 'object'),
  pips integer NOT NULL DEFAULT 0 CHECK (pips >= 0 AND pips <= 20),
  image_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ranks_min_posts_idx ON core.ranks (min_posts DESC);

CREATE TABLE IF NOT EXISTS core.badge_rules (
  badge_id bigint PRIMARY KEY REFERENCES core.badges (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (
    type IN ('post_count', 'reputation', 'days_joined', 'reactions_received', 'topics_started', 'posts_in_forum')
  ),
  threshold integer NOT NULL CHECK (threshold >= 0),
  forum_id bigint REFERENCES core.forums (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT badge_rules_forum_check CHECK (
    (type = 'posts_in_forum' AND forum_id IS NOT NULL)
    OR (type <> 'posts_in_forum' AND forum_id IS NULL)
  )
);

RESET ROLE;

GRANT SELECT ON core.ranks, core.badge_rules TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.ranks TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.ranks_id_seq TO staff_api;

GRANT INSERT, UPDATE, DELETE ON core.badge_rules TO staff_api, workers;

-- Rank and badge management are separate ACP capabilities (ADR 0005).
INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, p.permission, to_jsonb(true)
FROM core.groups g
CROSS JOIN (VALUES ('acp.ranks'), ('acp.badges'), ('members.badges')) AS p (permission)
WHERE g.key = 'administrators'
ON CONFLICT (group_id, key) DO NOTHING;
