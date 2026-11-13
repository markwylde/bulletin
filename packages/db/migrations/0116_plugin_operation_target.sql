-- 0116: each lifecycle operation records the bundle version it targets, so resuming an
-- interrupted upgrade never reuses another upgrade's completed migration step (ADR 0009).

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.plugin_operations
  ADD COLUMN IF NOT EXISTS target_version text;

RESET ROLE;
