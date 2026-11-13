-- 0115: forward migration for the plugin SQL hardening from ADR 0009. It lives here (not in
-- 0001) so databases created from main can upgrade without a checksum mismatch.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plugin_migrator') THEN
    CREATE ROLE plugin_migrator LOGIN;
  END IF;
END
$$;

ALTER ROLE plugin_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

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
