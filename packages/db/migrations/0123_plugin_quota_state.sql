-- 0123: the storage-quota write revocation must survive a broker restart (ADR 0009).
-- Provisioning re-grants DML on the runtime role, so the revoked state has to be durable in
-- the database rather than remembered in process memory.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.plugin_quota (
  plugin_id text PRIMARY KEY,
  writes_revoked boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

RESET ROLE;

GRANT SELECT ON core.plugin_quota TO user_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.plugin_quota TO staff_api, workers;
