-- 0024: Spike S1 template storage for the dev-only `/spike/rendering` route (ADR 0008).
-- Spike scaffolding: task 2.1 and task 8.2 replace these tables with `core.themes` and
-- `core.theme_templates`. `user_app` only reads them; the base seed writes the fixtures.

SET LOCAL ROLE bulletin_owner;

-- A theme is a versioned set of template bodies. `version` is the cache-key component
-- (themeId@version in ADR 0006); the spike switches between whole themes rather than
-- inheriting, which task 2.1 adds.
CREATE TABLE IF NOT EXISTS core.render_spike_themes (
  name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_-]*$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.render_spike_templates (
  theme_name text NOT NULL REFERENCES core.render_spike_themes (name) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_.-]*$'),
  body text NOT NULL,
  PRIMARY KEY (theme_name, name)
);

-- Plugin-style hook fragments. `generation` stands in for `pluginsGeneration` (ADR 0006,
-- 0009): installing or toggling a plugin bumps it, which changes the cache variant.
CREATE TABLE IF NOT EXISTS core.render_spike_hooks (
  generation integer NOT NULL CHECK (generation > 0),
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_.-]*$'),
  body text NOT NULL,
  PRIMARY KEY (generation, name)
);

RESET ROLE;

GRANT SELECT ON core.render_spike_themes, core.render_spike_templates, core.render_spike_hooks
  TO user_app;
GRANT SELECT, INSERT, UPDATE ON
  core.render_spike_themes, core.render_spike_templates, core.render_spike_hooks
  TO user_api, staff_api, workers;
