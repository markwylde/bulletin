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
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugin_migrator') THEN
    CREATE ROLE plugin_migrator LOGIN;
  END IF;
END
$$;

ALTER ROLE bulletin_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE pii_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE user_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE user_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE staff_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE workers LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
-- Dedicated migration login for plugin schemas (ADR 0009). It is NOINHERIT and is made a
-- member of each plugin_<id>_owner only; migrations SET LOCAL ROLE to that owner.
ALTER ROLE plugin_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

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


-- Side-effecting built-ins are not reachable through PUBLIC (ADR 0009). The broker's SQL
-- allowlist rejects them too, but the grants are the second line of defence: a parser bypass
-- or a plpgsql body cannot call them unless the caller is one of the core roles below.
DO $$
DECLARE
  fn text;
  grantee text;
  functions text[] := ARRAY[
    'pg_catalog.set_config(text,text,boolean)',
    'pg_catalog.pg_notify(text,text)',
    'pg_catalog.pg_sleep(double precision)',
    'pg_catalog.pg_sleep_for(interval)',
    'pg_catalog.pg_sleep_until(timestamp with time zone)',
    'pg_catalog.pg_advisory_lock(bigint)',
    'pg_catalog.pg_advisory_lock(integer,integer)',
    'pg_catalog.pg_advisory_lock_shared(bigint)',
    'pg_catalog.pg_advisory_lock_shared(integer,integer)',
    'pg_catalog.pg_advisory_unlock(bigint)',
    'pg_catalog.pg_advisory_unlock(integer,integer)',
    'pg_catalog.pg_advisory_unlock_all()',
    'pg_catalog.pg_advisory_unlock_shared(bigint)',
    'pg_catalog.pg_advisory_unlock_shared(integer,integer)',
    'pg_catalog.pg_advisory_xact_lock(bigint)',
    'pg_catalog.pg_advisory_xact_lock(integer,integer)',
    'pg_catalog.pg_advisory_xact_lock_shared(bigint)',
    'pg_catalog.pg_advisory_xact_lock_shared(integer,integer)',
    'pg_catalog.pg_try_advisory_lock(bigint)',
    'pg_catalog.pg_try_advisory_lock(integer,integer)',
    'pg_catalog.pg_try_advisory_lock_shared(bigint)',
    'pg_catalog.pg_try_advisory_lock_shared(integer,integer)',
    'pg_catalog.pg_try_advisory_xact_lock(bigint)',
    'pg_catalog.pg_try_advisory_xact_lock(integer,integer)',
    'pg_catalog.pg_try_advisory_xact_lock_shared(bigint)',
    'pg_catalog.pg_try_advisory_xact_lock_shared(integer,integer)',
    'pg_catalog.pg_terminate_backend(integer)',
    'pg_catalog.pg_terminate_backend(integer,bigint)',
    'pg_catalog.pg_cancel_backend(integer)',
    'pg_catalog.pg_read_file(text)',
    'pg_catalog.pg_read_file(text,bigint,bigint)',
    'pg_catalog.pg_read_binary_file(text)',
    'pg_catalog.pg_read_binary_file(text,bigint,bigint)',
    'pg_catalog.pg_ls_dir(text)',
    'pg_catalog.pg_ls_dir(text,boolean,boolean)',
    'pg_catalog.pg_stat_file(text)',
    'pg_catalog.pg_stat_file(text,boolean)',
    'pg_catalog.lo_import(text)',
    'pg_catalog.lo_import(text,oid)',
    'pg_catalog.lo_export(oid,text)',
    'pg_catalog.lo_create(oid)',
    'pg_catalog.lo_create(integer)',
    'pg_catalog.lo_unlink(oid)',
    'pg_catalog.lo_unlink(integer)',
    'pg_catalog.lo_get(oid)',
    'pg_catalog.lo_get(oid,bigint,integer)',
    'pg_catalog.lo_put(oid,bigint,bytea)',
    'pg_catalog.lo_from_bytea(oid,bytea)',
    'pg_catalog.lowrite(integer,bytea)',
    'pg_catalog.loread(integer,integer)',
    'pg_catalog.lo_open(oid,integer)',
    'pg_catalog.lo_close(integer)',
    'pg_catalog.lo_lseek(integer,integer,integer)',
    'pg_catalog.lo_lseek64(integer,bigint,integer)',
    'pg_catalog.lo_truncate(integer,integer)',
    'pg_catalog.lo_truncate64(integer,bigint)',
    'pg_catalog.dblink(text)',
    'pg_catalog.dblink(text,text)',
    'pg_catalog.dblink_connect(text)',
    'pg_catalog.dblink_connect_u(text)',
    'pg_catalog.dblink_disconnect()',
    'pg_catalog.dblink_exec(text)',
    'pg_catalog.dblink_exec(text,text)',
    'pg_catalog.pg_reload_conf()',
    'pg_catalog.pg_rotate_logfile()',
    'pg_catalog.pg_create_restore_point(text)',
    'pg_catalog.pg_switch_wal()',
    'pg_catalog.pg_start_backup(text,boolean,boolean)',
    'pg_catalog.pg_stop_backup(boolean,boolean)',
    'pg_catalog.pg_backup_start(text,boolean)',
    'pg_catalog.pg_backup_stop(boolean)',
    'pg_catalog.pg_promote(boolean,integer)'
  ];
  core_roles text[] := ARRAY[
    'bulletin_owner', 'pii_owner', 'user_api', 'staff_api', 'workers'
  ];
BEGIN
  FOREACH fn IN ARRAY functions LOOP
    BEGIN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
    EXCEPTION WHEN undefined_function THEN
      NULL;
    END;

    FOREACH grantee IN ARRAY core_roles LOOP
      BEGIN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
      EXCEPTION WHEN undefined_function THEN
        NULL;
      END;
    END LOOP;
  END LOOP;
END
$$;
