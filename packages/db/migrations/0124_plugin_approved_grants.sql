-- 0124: the capabilities and egress hosts an admin actually approved at install/upgrade.
-- The broker and core APIs check these at runtime, never the manifest the bundle merely
-- declares, so editing or replacing a bundle cannot widen a running plugin's access.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.plugins
  ADD COLUMN IF NOT EXISTS approved_capabilities jsonb,
  ADD COLUMN IF NOT EXISTS approved_egress_hosts jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Existing installs were approved with the capabilities recorded at install time. Egress
-- hosts were not persisted before this migration, so they start empty (fail closed) and an
-- admin must re-approve them.
UPDATE core.plugins
SET approved_capabilities = capabilities
WHERE approved_capabilities IS NULL;

ALTER TABLE core.plugins
  ALTER COLUMN approved_capabilities SET DEFAULT '[]'::jsonb,
  ALTER COLUMN approved_capabilities SET NOT NULL;

RESET ROLE;
