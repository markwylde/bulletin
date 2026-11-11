-- 0076: the member directory: member-list permission, presence locations, board statistics
-- and leaderboard materialisations (member-profiles 4.1-4.5, ADR 0003, 0005, 0006).

SET LOCAL ROLE bulletin_owner;

-- Board statistics: the record number of members and guests online at once (task 4.3).
ALTER TABLE core.board_settings
  ADD COLUMN IF NOT EXISTS record_online_count integer NOT NULL DEFAULT 0;

ALTER TABLE core.board_settings
  ADD COLUMN IF NOT EXISTS record_online_at timestamptz;

-- Per-forum, per-period leaderboard contributions. Reads sum only rows for forums Guests may
-- read *now*, so making a forum private removes its contribution immediately (task 4.5).
CREATE TABLE IF NOT EXISTS core.leaderboard_entries (
  period text NOT NULL CHECK (period IN ('today', 'week', 'month', 'all')),
  metric text NOT NULL CHECK (metric IN ('posts', 'reactions')),
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  forum_id bigint NOT NULL REFERENCES core.forums (id) ON DELETE CASCADE,
  value integer NOT NULL CHECK (value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period, metric, member_id, forum_id)
);

CREATE INDEX IF NOT EXISTS leaderboard_entries_period_idx
  ON core.leaderboard_entries (period, metric, value DESC, member_id);

RESET ROLE;

GRANT SELECT ON core.leaderboard_entries TO user_app, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.leaderboard_entries TO workers, staff_api;

-- The maintenance worker records the online peak; every other board-setting write stays staff.
GRANT UPDATE (record_online_count, record_online_at) ON core.board_settings TO workers;

-- The member list is a normal community feature, not staff-only. Existing groups get it here;
-- the seed grants it to the groups it creates (Regulars, VIP, moderators).
INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, 'members.view_list', 'true'::jsonb
FROM core.groups g
WHERE g.key IN ('guests', 'members', 'super_moderators', 'administrators')
ON CONFLICT (group_id, key) DO NOTHING;
