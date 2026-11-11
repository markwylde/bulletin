-- 0058: staff dead-letter access (ADR 0011).
--
-- pg-boss owns `pgboss.job` and creates it after migrations run, so the access is granted by
-- default privileges for future objects and applied to existing objects when present. The staff
-- app lists failed jobs and retries one by flipping its state back to `retry`.

ALTER DEFAULT PRIVILEGES FOR ROLE workers IN SCHEMA pgboss
  GRANT SELECT, UPDATE ON TABLES TO staff_api;

ALTER DEFAULT PRIVILEGES FOR ROLE workers IN SCHEMA pgboss
  GRANT USAGE ON TYPES TO staff_api;

GRANT USAGE ON SCHEMA pgboss TO staff_api;

DO $$
BEGIN
  IF to_regclass('pgboss.job') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, UPDATE ON pgboss.job TO staff_api';
  END IF;

  IF to_regtype('pgboss.job_state') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE ON TYPE pgboss.job_state TO staff_api';
  END IF;
END
$$;
