-- 0121: `user_app` renders pages in-process from packages/domain (ADR 0001) and runs the same
-- read-path SQL as the APIs. Migration 0115 revoked side-effecting built-ins from PUBLIC but
-- only re-granted them to the API/worker roles, which broke search flood control, read-marker
-- races and reputation locks in user-app. Grant them to the read role too, and mark the
-- migration role as platform infrastructure so no plugin namespace can claim it.

DO $$
DECLARE
  fn record;
  function_names text[] := ARRAY[
    'set_config',
    'pg_notify',
    'pg_sleep',
    'pg_sleep_for',
    'pg_sleep_until',
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
    'pg_try_advisory_xact_lock_shared',
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
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pg_catalog' AND p.proname = ANY(function_names)
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO user_app', fn.signature);
  END LOOP;
END
$$;

COMMENT ON ROLE plugin_migrator IS 'bulletin:infrastructure:plugin_migrator';
