-- 0029: the user-app reports template failures through a buffer, not the durable audit log
-- (ADR 0001, 0008, 0012). user_app may append to this UNLOGGED queue only; the workers role
-- moves entries into `core.admin_log` as the authorised writer (see the maintenance job).
--
-- Migration 0028 gave user_app direct INSERT on `core.admin_log`; that exception is removed.

SET LOCAL ROLE bulletin_owner;

REVOKE INSERT ON core.admin_log FROM user_app;
REVOKE USAGE ON SEQUENCE core.admin_log_id_seq FROM user_app;

CREATE UNLOGGED TABLE IF NOT EXISTS core.system_audit_buffer (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL CHECK (char_length(btrim(action)) > 0),
  target_type text,
  target_id bigint,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

RESET ROLE;

-- The renderer appends only; a crash can lose a queued report, which is acceptable for a
-- best-effort admin notification (the console log still carries it).
GRANT INSERT ON core.system_audit_buffer TO user_app;
GRANT USAGE ON SEQUENCE core.system_audit_buffer_id_seq TO user_app;

-- The authorised writer drains the buffer into the durable log.
GRANT SELECT, DELETE ON core.system_audit_buffer TO workers;
GRANT INSERT ON core.admin_log TO workers;
GRANT USAGE ON SEQUENCE core.admin_log_id_seq TO workers;
