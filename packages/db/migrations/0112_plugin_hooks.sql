-- 0112: plugin hook fragments, template overrides and the pluginsGeneration counter (ADR 0009).
-- Hook fragments already exist from the rendering spike; plugin installs now own rows by
-- generation, including whole-template overrides.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.hook_fragments
  ADD COLUMN IF NOT EXISTS plugin_id text,
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'hook'
    CHECK (kind IN ('hook', 'override'));

CREATE INDEX IF NOT EXISTS hook_fragments_plugin_idx
  ON core.hook_fragments (plugin_id);

CREATE TABLE IF NOT EXISTS core.plugin_generation (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO core.plugin_generation (id, generation)
VALUES (true, 1)
ON CONFLICT (id) DO NOTHING;

-- Registry entries installed from manifests. Lifecycle writes these; core services read them.
CREATE TABLE IF NOT EXISTS core.plugin_event_subscriptions (
  plugin_id text NOT NULL,
  event_type text NOT NULL,
  PRIMARY KEY (plugin_id, event_type)
);

CREATE TABLE IF NOT EXISTS core.plugin_jobs (
  plugin_id text NOT NULL,
  name text NOT NULL,
  schedule text,
  PRIMARY KEY (plugin_id, name)
);

CREATE TABLE IF NOT EXISTS core.plugin_settings (
  plugin_id text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL DEFAULT 'null'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, key)
);

CREATE TABLE IF NOT EXISTS core.plugin_registry (
  plugin_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('setting', 'forum_action', 'flag', 'route', 'job', 'fragment')),
  key text NOT NULL,
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (plugin_id, kind, key)
);

RESET ROLE;

GRANT SELECT ON core.plugin_generation TO user_app;
GRANT SELECT, INSERT, UPDATE ON core.plugin_generation TO user_api, staff_api, workers;
GRANT SELECT, INSERT, UPDATE ON core.hook_fragments TO user_api, staff_api, workers;
GRANT SELECT ON core.plugin_event_subscriptions, core.plugin_jobs, core.plugin_settings,
  core.plugin_registry TO user_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  core.plugin_event_subscriptions, core.plugin_jobs, core.plugin_settings,
  core.plugin_registry TO user_api, staff_api, workers;
