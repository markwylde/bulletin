-- 0067: reputation entries, member totals and the board's reputation settings (ADR 0005, 0006).
--
-- Reputation is the sum of entries against a member's posts. `members.reputation` is a
-- denormalised total, recomputed by the giving transaction, the staff tools and the recount
-- job; a change bumps only `member:{id}` so the author card rebuilds (ADR 0006).

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.reputation_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id bigint NOT NULL REFERENCES core.posts (id) ON DELETE CASCADE,
  giver_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  receiver_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  -- Explicit votes are +1/-1; a reaction link stores the reaction's -1, 0 or +1 weight.
  points smallint NOT NULL CHECK (points BETWEEN -1 AND 1),
  source text NOT NULL CHECK (source IN ('vote', 'reaction')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Once per post per giver and source: a vote cannot be repeated and a reaction is one row.
  CONSTRAINT reputation_entries_once_key UNIQUE (post_id, giver_id, source),
  CONSTRAINT reputation_entries_no_self CHECK (giver_id <> receiver_id)
);

CREATE INDEX IF NOT EXISTS reputation_entries_receiver_idx
  ON core.reputation_entries (receiver_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS reputation_entries_giver_day_idx
  ON core.reputation_entries (giver_id, created_at DESC);

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS reputation integer NOT NULL DEFAULT 0;

-- Board-wide reputation controls: the reaction link, the display switch and the label scale.
ALTER TABLE core.board_settings
  ADD COLUMN IF NOT EXISTS reactions_affect_reputation boolean NOT NULL DEFAULT false;

ALTER TABLE core.board_settings
  ADD COLUMN IF NOT EXISTS reputation_display boolean NOT NULL DEFAULT true;

ALTER TABLE core.board_settings
  ADD COLUMN IF NOT EXISTS reputation_label_scale jsonb NOT NULL DEFAULT '[
    {"min": -1000000, "labelKey": "reputation.label.notorious"},
    {"min": -100, "labelKey": "reputation.label.disliked"},
    {"min": 0, "labelKey": "reputation.label.neutral"},
    {"min": 100, "labelKey": "reputation.label.respected"},
    {"min": 500, "labelKey": "reputation.label.revered"}
  ]'::jsonb;

RESET ROLE;

-- Reading roles render totals; user-api gives and links reactions; staff remove and recount.
GRANT SELECT ON core.reputation_entries TO user_app, user_api, staff_api, workers;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.reputation_entries TO user_api, workers;
GRANT SELECT, DELETE ON core.reputation_entries TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.reputation_entries_id_seq TO user_api, workers;

-- The staff reputation tools are a member-management capability (ADR 0005).
INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, 'members.reputation', to_jsonb(true)
FROM core.groups g
WHERE g.key = 'administrators'
ON CONFLICT (group_id, key) DO NOTHING;
