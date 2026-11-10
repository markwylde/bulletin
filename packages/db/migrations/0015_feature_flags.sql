-- 0015: feature flag definitions (ADR 0010).
-- Flags are a small registry keyed by a code-defined name, like settings and cache tags.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.feature_flags (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-zA-Z0-9]*([._][a-zA-Z0-9]+)*$'),
  description text NOT NULL CHECK (char_length(btrim(description)) > 0),
  owner text NOT NULL CHECK (char_length(btrim(owner)) > 0),
  default_value boolean NOT NULL,
  affects_render boolean NOT NULL DEFAULT false,
  client_visible boolean NOT NULL DEFAULT false,
  rules jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(rules) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

RESET ROLE;

GRANT SELECT ON core.feature_flags TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.feature_flags TO user_api, staff_api, workers;
