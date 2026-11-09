-- 0008: members, groups, sessions, login challenges and name history (ADR 0004, 0005, 0018).
-- Identity columns never live in `core`; DarkAuth issuer/subject/email are in `pii.identities`.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.groups (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  title text NOT NULL CHECK (char_length(btrim(title)) > 0),
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO core.groups (key, title, is_system)
VALUES
  ('guests', 'Guests', true),
  ('members', 'Members', true),
  ('administrators', 'Administrators', true),
  ('banned', 'Banned', true)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS core.members (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  display_name text,
  name_skeleton text,
  locale text CHECK (locale IN ('en', 'es', 'fr')),
  is_service boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  previous_visit_at timestamptz,
  last_active_at timestamptz,
  CONSTRAINT members_display_name_length_check
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 3 AND 32)
);

CREATE UNIQUE INDEX IF NOT EXISTS members_display_name_lower_key
  ON core.members (lower(display_name))
  WHERE display_name IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS members_name_skeleton_key
  ON core.members (name_skeleton)
  WHERE name_skeleton IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.member_groups (
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  group_id bigint NOT NULL REFERENCES core.groups (id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, group_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS member_groups_one_primary_key
  ON core.member_groups (member_id)
  WHERE is_primary;

CREATE INDEX IF NOT EXISTS member_groups_group_idx ON core.member_groups (group_id);

CREATE TABLE IF NOT EXISTS core.member_name_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  old_name text NOT NULL,
  new_name text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by bigint REFERENCES core.members (id) ON DELETE SET NULL,
  reason text
);

CREATE INDEX IF NOT EXISTS member_name_history_member_idx
  ON core.member_name_history (member_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS core.sessions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('user', 'staff')),
  token_hash bytea NOT NULL UNIQUE,
  previous_token_hash bytea,
  previous_token_expires_at timestamptz,
  rotate_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  reauth_at timestamptz NOT NULL,
  last_auth_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT sessions_previous_token_check
    CHECK ((previous_token_hash IS NULL) = (previous_token_expires_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_previous_token_hash_key
  ON core.sessions (previous_token_hash)
  WHERE previous_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_member_idx ON core.sessions (member_id);

CREATE TABLE IF NOT EXISTS core.session_grants (
  session_id bigint NOT NULL REFERENCES core.sessions (id) ON DELETE CASCADE,
  kind text NOT NULL,
  resource_id bigint NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (session_id, kind, resource_id)
);

CREATE TABLE IF NOT EXISTS core.login_challenges (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('user', 'staff')),
  state text NOT NULL UNIQUE,
  nonce text NOT NULL,
  session_id bigint REFERENCES core.sessions (id) ON DELETE CASCADE,
  code_verifier text,
  return_to text,
  max_age integer CHECK (max_age IS NULL OR max_age >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS login_challenges_expiry_idx
  ON core.login_challenges (expires_at)
  WHERE used_at IS NULL;

-- 0007 left `updated_by` untyped until members existed; erasure clears it.
ALTER TABLE core.string_overrides
  DROP CONSTRAINT IF EXISTS string_overrides_updated_by_fkey;

ALTER TABLE core.string_overrides
  ADD CONSTRAINT string_overrides_updated_by_fkey
  FOREIGN KEY (updated_by) REFERENCES core.members (id) ON DELETE SET NULL;

RESET ROLE;

GRANT SELECT ON core.groups TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.groups TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.groups_id_seq TO staff_api;

GRANT SELECT ON core.members TO user_app, workers;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.members TO user_api, staff_api;
GRANT SELECT, UPDATE, DELETE ON core.members TO workers;
GRANT USAGE, SELECT ON SEQUENCE core.members_id_seq TO user_api, staff_api, workers;

GRANT SELECT ON core.member_groups TO user_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.member_groups TO user_api, staff_api, workers;

GRANT SELECT ON core.member_name_history TO user_app, workers;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.member_name_history TO user_api, staff_api;
GRANT SELECT, UPDATE, DELETE ON core.member_name_history TO workers;
GRANT USAGE, SELECT ON SEQUENCE core.member_name_history_id_seq TO user_api, staff_api, workers;

GRANT SELECT ON core.sessions TO user_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.sessions TO user_api, staff_api, workers;
GRANT USAGE, SELECT ON SEQUENCE core.sessions_id_seq TO user_api, staff_api, workers;

GRANT SELECT ON core.session_grants TO user_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.session_grants TO user_api, staff_api, workers;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.login_challenges TO user_api, staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.login_challenges_id_seq TO user_api, staff_api;
