-- 0007: admin string overrides (ADR 0013).
-- updated_by becomes a member reference when identity-sessions adds core.members; erasure nulls it.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.string_overrides (
  locale text NOT NULL CHECK (locale IN ('en', 'es', 'fr')),
  key text NOT NULL,
  value text NOT NULL,
  updated_by bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (locale, key)
);

RESET ROLE;

GRANT SELECT ON core.string_overrides TO user_app, user_api, workers;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.string_overrides TO staff_api;
