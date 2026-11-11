-- 0075: member relationships: ignores, friendships and the hidden-friends preference
-- (member-profiles 3.1-3.3, ADR 0006, 0011, 0012).

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS hide_friends boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS core.member_ignores (
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  ignored_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, ignored_id),
  CONSTRAINT member_ignores_no_self CHECK (member_id <> ignored_id)
);

CREATE INDEX IF NOT EXISTS member_ignores_ignored_idx
  ON core.member_ignores (ignored_id);

-- Friendships are stored once with a canonical member order. `requested_by` is the member
-- who sent the pending request; accepting flips `state` to 'accepted'.
CREATE TABLE IF NOT EXISTS core.friendships (
  a_member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  b_member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('pending', 'accepted')),
  requested_by bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (a_member_id, b_member_id),
  CONSTRAINT friendships_order_check CHECK (a_member_id < b_member_id),
  CONSTRAINT friendships_requester_check CHECK (requested_by IN (a_member_id, b_member_id))
);

CREATE INDEX IF NOT EXISTS friendships_b_member_idx
  ON core.friendships (b_member_id);

RESET ROLE;

-- user_app renders the profile's friend list; user_api owns the writes; workers filter
-- notification recipients through the ignore list.
GRANT SELECT ON core.member_ignores TO user_app, user_api, staff_api, workers;
GRANT INSERT, DELETE ON core.member_ignores TO user_api;

GRANT SELECT ON core.friendships TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.friendships TO user_api;

-- Staff groups marked here cannot be ignored by members (spec, ignore list).
INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, 'members.unignorable', 'true'::jsonb
FROM core.groups g
WHERE g.key IN ('administrators', 'super_moderators', 'moderators')
ON CONFLICT (group_id, key) DO NOTHING;
