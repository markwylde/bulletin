-- 0122: migrations 0115 and 0121 re-granted file, large-object, backend-control and
-- replication built-ins to every application role. Those functions bypass table permissions and
-- the audited `pii` boundary (ADR 0011, 0012), so they must never be reachable from an app
-- role. App roles keep only what the code actually calls: `set_config`, `pg_notify` and the
-- advisory-lock family. Plugin runtime roles are not in this list and keep none of them.
--
-- The lists are resolved through pg_proc so a missing function (dblink is an extension) is
-- skipped instead of failing the migration.

DO $$
DECLARE
  fn record;
  grantee text;
  dangerous text[] := ARRAY[
    'pg_sleep',
    'pg_sleep_for',
    'pg_sleep_until',
    'pg_terminate_backend',
    'pg_cancel_backend',
    'pg_read_file',
    'pg_read_binary_file',
    'pg_ls_dir',
    'pg_stat_file',
    'lo_import',
    'lo_export',
    'lo_create',
    'lo_unlink',
    'lo_get',
    'lo_put',
    'lo_from_bytea',
    'lowrite',
    'loread',
    'lo_open',
    'lo_close',
    'lo_lseek',
    'lo_lseek64',
    'lo_truncate',
    'lo_truncate64',
    'dblink',
    'dblink_connect',
    'dblink_connect_u',
    'dblink_disconnect',
    'dblink_exec',
    'pg_reload_conf',
    'pg_rotate_logfile',
    'pg_create_restore_point',
    'pg_switch_wal',
    'pg_start_backup',
    'pg_stop_backup',
    'pg_backup_start',
    'pg_backup_stop',
    'pg_promote'
  ];
  keep text[] := ARRAY[
    'set_config',
    'pg_notify',
    'pg_advisory_lock',
    'pg_advisory_lock_shared',
    'pg_advisory_unlock',
    'pg_advisory_unlock_all',
    'pg_advisory_unlock_shared',
    'pg_advisory_xact_lock',
    'pg_advisory_xact_lock_shared',
    'pg_try_advisory_lock',
    'pg_try_advisory_lock_shared',
    'pg_try_advisory_xact_lock',
    'pg_try_advisory_xact_lock_shared'
  ];
  app_roles text[] := ARRAY[
    'bulletin_owner', 'pii_owner', 'user_api', 'staff_api', 'workers', 'user_app'
  ];
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('pg_catalog', 'public')
      AND p.proname = ANY (dangerous)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn.signature);

    FOREACH grantee IN ARRAY app_roles LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %I', fn.signature, grantee);
    END LOOP;
  END LOOP;

  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pg_catalog'
      AND p.proname = ANY (keep)
  LOOP
    FOREACH grantee IN ARRAY app_roles LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn.signature, grantee);
    END LOOP;
  END LOOP;
END
$$;
