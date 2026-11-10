-- 0018: the group and permission model (ADR 0005).
-- This migration creates the storage behind `domain/permissions/registry.ts`: groups gain
-- display attributes and ordering, the interim `group_acp_permissions` table becomes typed
-- `group_settings`, and masks, the forum matrix, moderators and the forum tree exist here.
-- `forum-structure` extends `core.forums` with slugs, paths, settings and counters.

SET LOCAL ROLE bulletin_owner;

-- ---------------------------------------------------------------------------------------------
-- Groups: display attributes and ordering
-- ---------------------------------------------------------------------------------------------

ALTER TABLE core.groups
  ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0;

ALTER TABLE core.groups
  ADD COLUMN IF NOT EXISTS name_colour text;

ALTER TABLE core.groups
  ADD COLUMN IF NOT EXISTS icon text;

ALTER TABLE core.groups
  DROP CONSTRAINT IF EXISTS groups_name_colour_check;

ALTER TABLE core.groups
  ADD CONSTRAINT groups_name_colour_check
  CHECK (name_colour IS NULL OR name_colour ~ '^#[0-9a-fA-F]{6}$');

ALTER TABLE core.groups
  DROP CONSTRAINT IF EXISTS groups_icon_check;

ALTER TABLE core.groups
  ADD CONSTRAINT groups_icon_check
  CHECK (icon IS NULL OR icon ~ '^[a-z][a-z0-9_-]*$');

CREATE INDEX IF NOT EXISTS groups_display_order_idx ON core.groups (display_order, id);

INSERT INTO core.groups (key, title, is_system, display_order)
VALUES
  ('super_moderators', 'Super Moderators', true, 40)
ON CONFLICT (key) DO NOTHING;

UPDATE core.groups SET display_order = 10 WHERE key = 'guests' AND display_order = 0;
UPDATE core.groups SET display_order = 20 WHERE key = 'members' AND display_order = 0;
UPDATE core.groups SET display_order = 30 WHERE key = 'banned' AND display_order = 0;
UPDATE core.groups SET display_order = 40 WHERE key = 'super_moderators' AND display_order = 0;
UPDATE core.groups SET display_order = 50 WHERE key = 'administrators' AND display_order = 0;

-- Built-in groups are permanent; the editor may rename and reorder them but never delete them.
CREATE OR REPLACE FUNCTION core.protect_system_group()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
BEGIN
  IF OLD.is_system THEN
    RAISE EXCEPTION 'group % is a built-in group and cannot be deleted', OLD.key
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS groups_protect_system ON core.groups;

CREATE TRIGGER groups_protect_system
BEFORE DELETE ON core.groups
FOR EACH ROW EXECUTE FUNCTION core.protect_system_group();

REVOKE ALL ON FUNCTION core.protect_system_group() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Member groups: exactly one primary group per member (ADR 0005)
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION core.assert_member_has_one_primary_group()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_member_id bigint;
  v_primaries integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_member_id := OLD.member_id;
  ELSE
    v_member_id := NEW.member_id;
  END IF;

  -- Erasure deletes the member row; its memberships cascade and no longer need a primary.
  IF NOT EXISTS (SELECT 1 FROM core.members WHERE id = v_member_id) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_primaries
  FROM core.member_groups
  WHERE member_id = v_member_id
    AND is_primary;

  IF v_primaries <> 1 THEN
    RAISE EXCEPTION 'member % must have exactly one primary group (found %)',
      v_member_id, v_primaries
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS member_groups_one_primary ON core.member_groups;

CREATE CONSTRAINT TRIGGER member_groups_one_primary
AFTER INSERT OR UPDATE OR DELETE ON core.member_groups
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION core.assert_member_has_one_primary_group();

REVOKE ALL ON FUNCTION core.assert_member_has_one_primary_group() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Group settings: the typed registry's storage (settings and permission grants)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.group_settings (
  group_id bigint NOT NULL REFERENCES core.groups (id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$'),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, key),
  CONSTRAINT group_settings_scalar_value_check
    CHECK (jsonb_typeof(value) IN ('boolean', 'number', 'string'))
);

CREATE INDEX IF NOT EXISTS group_settings_key_idx ON core.group_settings (key);

-- Migrate the interim staff-console permission rows into the typed registry storage.
INSERT INTO core.group_settings (group_id, key, value)
SELECT group_id, permission, to_jsonb(true)
FROM core.group_acp_permissions
ON CONFLICT (group_id, key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();

-- Registry permissions introduced by this change.
INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, p.permission, to_jsonb(true)
FROM core.groups g
CROSS JOIN (
  VALUES
    ('acp.groups'),
    ('acp.members.groups'),
    ('acp.permissions'),
    ('sessions.revoke'),
    ('members.view_name_history')
) AS p (permission)
WHERE g.key = 'administrators'
ON CONFLICT (group_id, key) DO NOTHING;

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
    JOIN core.group_settings s ON s.group_id = mg.group_id
    WHERE mg.member_id = p_member_id
      AND s.key = p_permission
      AND s.value = 'true'::jsonb
  );
$$;

REVOKE ALL ON FUNCTION core.has_acp(bigint, text) FROM PUBLIC;

DROP TABLE IF EXISTS core.group_acp_permissions;

-- ---------------------------------------------------------------------------------------------
-- Forum tree: the minimum the permission model needs. `forum-structure` adds the rest.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.forums (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id bigint REFERENCES core.forums (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forums_no_self_parent_check CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS forums_parent_idx ON core.forums (parent_id);

-- ---------------------------------------------------------------------------------------------
-- Masks and the forum × mask matrix (ADR 0005)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.masks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  title text NOT NULL CHECK (char_length(btrim(title)) > 0),
  description text NOT NULL DEFAULT '',
  is_system boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS masks_display_order_idx ON core.masks (display_order, id);

CREATE TABLE IF NOT EXISTS core.group_masks (
  group_id bigint NOT NULL REFERENCES core.groups (id) ON DELETE CASCADE,
  mask_id bigint NOT NULL REFERENCES core.masks (id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, mask_id)
);

CREATE INDEX IF NOT EXISTS group_masks_mask_idx ON core.group_masks (mask_id);

-- `actions` is an action bitmap using the order in `domain/permissions/actions.ts`
-- (show, read, start, reply, upload, download, vote, then plugin actions).
-- A forum inherits its parent's row for the mask unless `inherits` is false.
CREATE TABLE IF NOT EXISTS core.forum_permissions (
  forum_id bigint NOT NULL REFERENCES core.forums (id) ON DELETE CASCADE,
  mask_id bigint NOT NULL REFERENCES core.masks (id) ON DELETE CASCADE,
  actions integer NOT NULL DEFAULT 0 CHECK (actions >= 0),
  inherits boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (forum_id, mask_id)
);

CREATE INDEX IF NOT EXISTS forum_permissions_mask_idx ON core.forum_permissions (mask_id);

-- ---------------------------------------------------------------------------------------------
-- Moderators: member or group assignments with granular powers (ADR 0005)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.moderators (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  forum_id bigint NOT NULL REFERENCES core.forums (id) ON DELETE CASCADE,
  member_id bigint REFERENCES core.members (id) ON DELETE CASCADE,
  group_id bigint REFERENCES core.groups (id) ON DELETE CASCADE,
  powers text[] NOT NULL DEFAULT '{}',
  this_forum_only boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderators_one_assignee_check CHECK (num_nonnulls(member_id, group_id) = 1),
  CONSTRAINT moderators_known_powers_check CHECK (
    powers <@ ARRAY[
      'edit', 'soft_delete', 'hard_delete', 'restore', 'move', 'merge', 'split', 'pin',
      'lock', 'approve', 'see_unapproved', 'see_deleted', 'view_ips', 'warn',
      'view_edit_history', 'use_multimod'
    ]::text[]
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS moderators_forum_member_key
  ON core.moderators (forum_id, member_id)
  WHERE member_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS moderators_forum_group_key
  ON core.moderators (forum_id, group_id)
  WHERE group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS moderators_member_idx
  ON core.moderators (member_id)
  WHERE member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS moderators_group_idx
  ON core.moderators (group_id)
  WHERE group_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- SQL mirror of moderator-power evaluation for PII definer functions (ADR 0005, 0012)
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION core.forum_lineage(p_forum_id bigint)
RETURNS TABLE (id bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  WITH RECURSIVE lineage AS (
    SELECT f.id, f.parent_id
    FROM core.forums f
    WHERE f.id = p_forum_id

    UNION ALL

    SELECT parent.id, parent.parent_id
    FROM core.forums parent
    JOIN lineage child ON child.parent_id = parent.id
  )
  SELECT lineage.id FROM lineage;
$$;

REVOKE ALL ON FUNCTION core.forum_lineage(bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.has_mod_power(
  p_member_id bigint,
  p_forum_id bigint,
  p_power text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT
    EXISTS (SELECT 1 FROM core.forums WHERE id = p_forum_id)
    AND NOT EXISTS (
      SELECT 1
      FROM core.member_groups mg
      JOIN core.groups g ON g.id = mg.group_id
      WHERE mg.member_id = p_member_id
        AND g.key = 'banned'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM core.member_groups mg
      JOIN core.group_settings s ON s.group_id = mg.group_id
      WHERE mg.member_id = p_member_id
        AND s.key = 'restrictions.banned'
        AND s.value = 'true'::jsonb
    )
    AND (
      -- Global powers granted by a group setting (super moderators).
      EXISTS (
        SELECT 1
        FROM core.member_groups mg
        JOIN core.group_settings s ON s.group_id = mg.group_id
        WHERE mg.member_id = p_member_id
          AND s.key = 'moderation.' || p_power
          AND s.value = 'true'::jsonb
      )
      OR
      -- Member or group assignments on this forum or an ancestor unless "this forum only".
      EXISTS (
        SELECT 1
        FROM core.moderators m
        WHERE (m.member_id = p_member_id
               OR m.group_id IN (
                 SELECT mg.group_id FROM core.member_groups mg WHERE mg.member_id = p_member_id
               ))
          AND p_power = ANY (m.powers)
          AND m.forum_id IN (SELECT id FROM core.forum_lineage(p_forum_id))
          AND (NOT m.this_forum_only OR m.forum_id = p_forum_id)
      )
    );
$$;

REVOKE ALL ON FUNCTION core.has_mod_power(bigint, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.has_mod_power(bigint, bigint, text) TO pii_owner;

RESET ROLE;

GRANT SELECT ON core.groups TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.groups TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.groups_id_seq TO staff_api;

GRANT SELECT ON core.group_settings TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.group_settings TO staff_api;

GRANT SELECT ON core.forums TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.forums TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.forums_id_seq TO staff_api;

GRANT SELECT ON core.masks TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.masks TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.masks_id_seq TO staff_api;

GRANT SELECT ON core.group_masks TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.group_masks TO staff_api;

GRANT SELECT ON core.forum_permissions TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.forum_permissions TO staff_api;

GRANT SELECT ON core.moderators TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.moderators TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.moderators_id_seq TO staff_api;

GRANT EXECUTE ON FUNCTION core.has_acp(bigint, text) TO pii_owner, staff_api, workers;
