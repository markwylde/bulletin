-- 0013: the staff console shell (ADR 0005, 0012, 0014, 0018).
-- ACP permissions live in a table until the typed group-settings registry replaces them in
-- `groups-permissions`. `core.has_acp` is the SQL mirror used by PII definer functions.

SET LOCAL ROLE bulletin_owner;

INSERT INTO core.groups (key, title, is_system)
VALUES ('super_moderators', 'Super Moderators', true)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS core.group_acp_permissions (
  group_id bigint NOT NULL REFERENCES core.groups (id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission ~ '^acp\.[a-z][a-z0-9_]*$'),
  PRIMARY KEY (group_id, permission)
);

INSERT INTO core.group_acp_permissions (group_id, permission)
SELECT g.id, p.permission
FROM core.groups g
CROSS JOIN (
  VALUES
    ('acp.access'),
    ('acp.log'),
    ('acp.members'),
    ('acp.settings'),
    ('acp.strings'),
    ('acp.system')
) AS p (permission)
WHERE g.key = 'administrators'
ON CONFLICT DO NOTHING;

INSERT INTO core.group_acp_permissions (group_id, permission)
SELECT g.id, p.permission
FROM core.groups g
CROSS JOIN (VALUES ('acp.access'), ('acp.members')) AS p (permission)
WHERE g.key = 'super_moderators'
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS core.member_prefs (
  member_id bigint PRIMARY KEY REFERENCES core.members (id) ON DELETE CASCADE,
  staff_scheme text NOT NULL DEFAULT 'system'
    CHECK (staff_scheme IN ('light', 'dark', 'system')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.admin_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_member_id bigint REFERENCES core.members (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (char_length(btrim(action)) > 0),
  target_type text,
  target_id bigint,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_log_created_at_idx ON core.admin_log (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS admin_log_actor_idx ON core.admin_log (actor_member_id, created_at DESC);

CREATE OR REPLACE FUNCTION core.has_acp(p_member_id bigint, p_permission text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM core.member_groups mg
    JOIN core.group_acp_permissions p ON p.group_id = mg.group_id
    WHERE mg.member_id = p_member_id
      AND p.permission = p_permission
  );
$$;

REVOKE ALL ON FUNCTION core.has_acp(bigint, text) FROM PUBLIC;

RESET ROLE;

GRANT SELECT ON core.group_acp_permissions TO user_app, user_api, staff_api, workers;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.group_acp_permissions TO staff_api;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.member_prefs TO staff_api;

GRANT SELECT, INSERT ON core.admin_log TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.admin_log_id_seq TO staff_api;

GRANT EXECUTE ON FUNCTION core.has_acp(bigint, text) TO pii_owner, staff_api, workers;
