-- 0073: member profiles: about, privacy, signatures, custom profile fields and badge display
-- (ADR 0005, 0012). Badge definitions and awards are managed from `member-profiles` task 5.2;
-- the tables exist here because profile pages render a member's awarded badges from day one.

SET LOCAL ROLE bulletin_owner;

-- ---------------------------------------------------------------------------------------------
-- Member profile columns
-- ---------------------------------------------------------------------------------------------

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS about_md text NOT NULL DEFAULT '';

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS about_html text NOT NULL DEFAULT '';

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS hide_online boolean NOT NULL DEFAULT false;

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS hide_from_member_list boolean NOT NULL DEFAULT false;

-- Signature editing and rendering land in task 2.1; the columns are part of the profile row.
ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS signature_md text NOT NULL DEFAULT '';

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS signature_html text NOT NULL DEFAULT '';

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS signature_updated_at timestamptz;

ALTER TABLE core.members DROP CONSTRAINT IF EXISTS members_about_length_check;

ALTER TABLE core.members
  ADD CONSTRAINT members_about_length_check
  CHECK (char_length(about_md) <= 20000 AND char_length(about_html) <= 100000);

ALTER TABLE core.members DROP CONSTRAINT IF EXISTS members_signature_length_check;

ALTER TABLE core.members
  ADD CONSTRAINT members_signature_length_check
  CHECK (char_length(signature_md) <= 10000 AND char_length(signature_html) <= 50000);

-- ---------------------------------------------------------------------------------------------
-- Custom profile fields (design: profile_fields, profile_field_groups, member_field_values)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.profile_fields (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type text NOT NULL CHECK (
    type IN ('short_text', 'long_text', 'number', 'date', 'url', 'select', 'multiselect')
  ),
  required boolean NOT NULL DEFAULT false,
  -- `{"en": "...", "es": "...", "fr": "..."}`: staff-created labels are data, not catalog keys.
  labels jsonb NOT NULL CHECK (jsonb_typeof(labels) = 'object'),
  -- Select options: `[{"value": "x", "labels": {"en": "...", "es": "...", "fr": "..."}}]`.
  options jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array'),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profile_fields_position_idx
  ON core.profile_fields (position, id);

-- A field with no rows is visible to everyone and editable by nobody. Rows narrow visibility
-- to the listed groups and grant editing to the groups marked `can_edit`.
CREATE TABLE IF NOT EXISTS core.profile_field_groups (
  field_id bigint NOT NULL REFERENCES core.profile_fields (id) ON DELETE CASCADE,
  group_id bigint NOT NULL REFERENCES core.groups (id) ON DELETE CASCADE,
  can_view boolean NOT NULL DEFAULT true,
  can_edit boolean NOT NULL DEFAULT false,
  PRIMARY KEY (field_id, group_id)
);

CREATE INDEX IF NOT EXISTS profile_field_groups_group_idx
  ON core.profile_field_groups (group_id);

CREATE TABLE IF NOT EXISTS core.member_field_values (
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  field_id bigint NOT NULL REFERENCES core.profile_fields (id) ON DELETE CASCADE,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, field_id)
);

CREATE INDEX IF NOT EXISTS member_field_values_field_idx
  ON core.member_field_values (field_id);

-- ---------------------------------------------------------------------------------------------
-- Badges: definitions and awards (management lands with task 5.2)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.badges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_-]*$'),
  labels jsonb NOT NULL CHECK (jsonb_typeof(labels) = 'object'),
  description_labels jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(description_labels) = 'object'),
  image_key text,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS badges_position_idx ON core.badges (position, id);

CREATE TABLE IF NOT EXISTS core.member_badges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  badge_id bigint NOT NULL REFERENCES core.badges (id) ON DELETE CASCADE,
  awarded_by bigint REFERENCES core.members (id) ON DELETE SET NULL,
  reason text,
  featured boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT member_badges_once_key UNIQUE (member_id, badge_id)
);

CREATE INDEX IF NOT EXISTS member_badges_member_idx
  ON core.member_badges (member_id, revoked_at, created_at DESC);

RESET ROLE;

-- user_app renders profiles; user_api writes the member's own profile; staff_api manages
-- field definitions and staff edits.
GRANT SELECT ON core.profile_fields TO user_app, user_api, staff_api;
GRANT INSERT, UPDATE, DELETE ON core.profile_fields TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.profile_fields_id_seq TO staff_api;

GRANT SELECT ON core.profile_field_groups TO user_app, user_api, staff_api;
GRANT INSERT, UPDATE, DELETE ON core.profile_field_groups TO staff_api;

GRANT SELECT ON core.member_field_values TO user_app, user_api, staff_api;
GRANT INSERT, UPDATE, DELETE ON core.member_field_values TO user_api, staff_api;

GRANT SELECT ON core.badges TO user_app, user_api, staff_api;
GRANT INSERT, UPDATE, DELETE ON core.badges TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.badges_id_seq TO staff_api;

GRANT SELECT ON core.member_badges TO user_app, user_api, staff_api;
GRANT INSERT, UPDATE, DELETE ON core.member_badges TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.member_badges_id_seq TO staff_api;

-- Staff capabilities: the field manager and seeing members who hide their presence.
INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, p.permission, to_jsonb(true)
FROM core.groups g
CROSS JOIN (
  VALUES ('acp.profile_fields'), ('members.view_hidden')
) AS p (permission)
WHERE g.key = 'administrators'
ON CONFLICT (group_id, key) DO NOTHING;
