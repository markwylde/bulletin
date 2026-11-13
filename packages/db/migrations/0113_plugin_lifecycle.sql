-- 0113: plugin lifecycle state, operations journal, personal-data registry and service grants.
-- ADR 0009: installs/upgrades are journaled, disable keeps data, uninstall may keep or drop it.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.plugins (
  plugin_id text PRIMARY KEY CHECK (plugin_id ~ '^[a-z0-9][a-z0-9-]{0,48}$'),
  version text NOT NULL,
  sdk_version text NOT NULL,
  state text NOT NULL
    CHECK (state IN ('installing', 'active', 'disabled', 'upgrading', 'failed', 'uninstalled')),
  enabled boolean NOT NULL DEFAULT false,
  generation integer NOT NULL DEFAULT 1,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  service_principal_group text NOT NULL DEFAULT 'Guests',
  elevated_grants jsonb NOT NULL DEFAULT '[]'::jsonb,
  personal_data jsonb NOT NULL DEFAULT '[]'::jsonb,
  bundle bytea,
  signature text,
  checksum text,
  error text,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.plugin_operations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plugin_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('install', 'upgrade', 'uninstall')),
  step text NOT NULL,
  state text NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS plugin_operations_plugin_idx
  ON core.plugin_operations (plugin_id, id DESC);

-- Kept after disable/uninstall so export/erasure still knows where personal data lives.
CREATE TABLE IF NOT EXISTS core.plugin_personal_data (
  plugin_id text NOT NULL,
  table_name text NOT NULL,
  member_column text NOT NULL,
  declared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, table_name, member_column)
);

CREATE TABLE IF NOT EXISTS core.plugin_gdpr_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plugin_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('export', 'erase')),
  member_id bigint,
  status text NOT NULL CHECK (status IN ('open', 'completed', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS core.plugin_breaker (
  plugin_id text NOT NULL,
  hook text NOT NULL,
  failures integer NOT NULL DEFAULT 0,
  last_error text,
  disabled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plugin_id, hook)
);

RESET ROLE;

GRANT SELECT ON core.plugins, core.plugin_operations, core.plugin_personal_data,
  core.plugin_gdpr_requests, core.plugin_breaker TO user_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.plugins, core.plugin_operations,
  core.plugin_personal_data, core.plugin_gdpr_requests, core.plugin_breaker
  TO user_api, staff_api, workers;
GRANT USAGE, SELECT ON core.plugin_operations_id_seq, core.plugin_gdpr_requests_id_seq
  TO staff_api, workers;
