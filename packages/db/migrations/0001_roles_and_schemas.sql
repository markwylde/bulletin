-- 0001: schemas, owners and login roles (ADR 0001, ADR 0012).
-- Roles are cluster-wide, so the DO blocks make this migration safe to apply to several
-- databases created from the same cluster.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bulletin_owner') THEN
    CREATE ROLE bulletin_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pii_owner') THEN
    CREATE ROLE pii_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'user_app') THEN
    CREATE ROLE user_app LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'user_api') THEN
    CREATE ROLE user_api LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staff_api') THEN
    CREATE ROLE staff_api LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workers') THEN
    CREATE ROLE workers LOGIN;
  END IF;
END
$$;

ALTER ROLE bulletin_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE pii_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE user_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE user_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE staff_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE workers LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION bulletin_owner;
CREATE SCHEMA IF NOT EXISTS pii AUTHORIZATION pii_owner;
ALTER SCHEMA core OWNER TO bulletin_owner;
ALTER SCHEMA pii OWNER TO pii_owner;

REVOKE ALL ON SCHEMA core FROM PUBLIC;
REVOKE ALL ON SCHEMA pii FROM PUBLIC;
REVOKE ALL ON SCHEMA pii FROM user_app, user_api, staff_api, workers;

GRANT USAGE ON SCHEMA core TO user_app, user_api, staff_api, workers;

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.schema_migrations (
  name text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.seed_runs (
  name text PRIMARY KEY,
  seed bigint NOT NULL,
  size text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.cache_tags (
  tag text PRIMARY KEY,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

RESET ROLE;

GRANT SELECT ON core.cache_tags TO user_app;
GRANT SELECT, INSERT, UPDATE ON core.cache_tags TO user_api, staff_api, workers;
GRANT SELECT, INSERT ON core.seed_runs TO user_api, staff_api, workers;
