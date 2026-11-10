-- 0025: theme template storage with parent inheritance (ADR 0008, task 2.1).
-- Replaces the spike S1 scaffolding tables. The `themes` change adds availability columns
-- (allowed groups, per-group default, source and signature) and template version history; the
-- names and keys here stay the same.
--
-- `core.render_spike_hooks` stays from migration 0024: plugin-style hook fragments are served
-- by the plugin platform (ADR 0009), not by the theme tables.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.themes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id bigint REFERENCES core.themes (id) ON DELETE RESTRICT,
  name text NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9_-]*$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT themes_no_self_parent_check CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX IF NOT EXISTS themes_parent_idx ON core.themes (parent_id);

-- One row per template a theme overrides. A theme inherits every name it does not define from
-- its parent chain; `version` bumps on every save so the compile cache misses (ADR 0008).
CREATE TABLE IF NOT EXISTS core.theme_templates (
  theme_id bigint NOT NULL REFERENCES core.themes (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_.-]*$'),
  body text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (theme_id, name)
);

DROP TABLE IF EXISTS core.render_spike_templates;
DROP TABLE IF EXISTS core.render_spike_themes;

RESET ROLE;

GRANT SELECT ON core.themes, core.theme_templates TO user_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.themes, core.theme_templates
  TO user_api, staff_api, workers;
