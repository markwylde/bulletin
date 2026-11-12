-- 0107: theme management storage (ADR 0008, task 2.1).
-- A theme owns templates (with version history), design tokens per scheme, custom CSS,
-- assets and string overrides. Rows in the child tables are the theme's own overrides; the
-- resolver walks `parent_id` for everything a child does not define.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.themes
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'custom'
    CHECK (source IN ('core', 'marketplace', 'upload', 'custom')),
  ADD COLUMN IF NOT EXISTS signature text,
  ADD COLUMN IF NOT EXISTS created_by bigint REFERENCES core.members (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE core.theme_templates
  ADD COLUMN IF NOT EXISTS updated_by bigint REFERENCES core.members (id) ON DELETE SET NULL;

-- Append-only template history. Restoring an old version writes a new version with that body.
CREATE TABLE IF NOT EXISTS core.theme_template_versions (
  theme_id bigint NOT NULL REFERENCES core.themes (id) ON DELETE CASCADE,
  name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  body text NOT NULL,
  updated_by bigint REFERENCES core.members (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (theme_id, name, version)
);

CREATE INDEX IF NOT EXISTS theme_template_versions_lookup_idx
  ON core.theme_template_versions (theme_id, name, version DESC);

CREATE TABLE IF NOT EXISTS core.theme_tokens (
  theme_id bigint NOT NULL REFERENCES core.themes (id) ON DELETE CASCADE,
  scheme text NOT NULL CHECK (scheme IN ('light', 'dark')),
  tokens jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (theme_id, scheme)
);

CREATE TABLE IF NOT EXISTS core.theme_css (
  theme_id bigint PRIMARY KEY REFERENCES core.themes (id) ON DELETE CASCADE,
  css text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.theme_assets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  theme_id bigint NOT NULL REFERENCES core.themes (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9._-]*$'),
  storage_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  bytes integer NOT NULL CHECK (bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES core.members (id) ON DELETE SET NULL,
  UNIQUE (theme_id, name)
);

CREATE TABLE IF NOT EXISTS core.theme_strings (
  theme_id bigint NOT NULL REFERENCES core.themes (id) ON DELETE CASCADE,
  locale text NOT NULL CHECK (locale IN ('en', 'es', 'fr')),
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9_.-]+$'),
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (theme_id, locale, key)
);

-- Availability is managed with the chooser (task 4.1); the guest `bp` validation in task 2.5
-- already refuses a theme that is not available to the Guests group.
CREATE TABLE IF NOT EXISTS core.theme_allowed_groups (
  theme_id bigint NOT NULL REFERENCES core.themes (id) ON DELETE CASCADE,
  group_id bigint NOT NULL REFERENCES core.groups (id) ON DELETE CASCADE,
  PRIMARY KEY (theme_id, group_id)
);

CREATE TABLE IF NOT EXISTS core.theme_group_defaults (
  group_id bigint PRIMARY KEY REFERENCES core.groups (id) ON DELETE CASCADE,
  theme_id bigint NOT NULL REFERENCES core.themes (id) ON DELETE CASCADE
);

-- Preview grants are written by user-app when the admin exchanges a signed token. A definer
-- function keeps that write narrow (ADR 0001): it can only create this one grant kind.
CREATE OR REPLACE FUNCTION core.grant_preview_theme(p_session_id bigint, p_theme_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.sessions WHERE id = p_session_id) THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM core.themes WHERE id = p_theme_id) THEN
    RETURN false;
  END IF;

  INSERT INTO core.session_grants (session_id, kind, resource_id, granted_at)
  VALUES (p_session_id, 'preview_theme_id', p_theme_id, now())
  ON CONFLICT (session_id, kind, resource_id) DO UPDATE SET granted_at = now();

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION core.grant_preview_theme(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.grant_preview_theme(bigint, bigint)
  TO user_app, user_api, staff_api, workers;

RESET ROLE;

-- Existing migrations grant each ACP section to the built-in administrators group. Migration
-- 0013 created that group, so this works on a fresh database before the seed runs.
INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, 'acp.themes', to_jsonb(true)
FROM core.groups g
WHERE g.key = 'administrators'
ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value;

GRANT SELECT ON
  core.theme_template_versions,
  core.theme_tokens,
  core.theme_css,
  core.theme_assets,
  core.theme_strings,
  core.theme_allowed_groups,
  core.theme_group_defaults
TO user_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  core.theme_template_versions,
  core.theme_tokens,
  core.theme_css,
  core.theme_assets,
  core.theme_strings,
  core.theme_allowed_groups,
  core.theme_group_defaults
TO user_api, staff_api, workers;
