-- 0144: installed plugin bundles live in object storage (ADR 0009).
--
-- staff-api verifies a marketplace bundle's checksum and signature, stores the bytes under an
-- opaque `plugin/` key and records the key here with the checksum. plugin-host reads the key,
-- re-checks the sha256 before unpacking, and runs the bundle. The legacy `bundle` bytea column
-- stays readable for rows written before this migration.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.plugins
  ADD COLUMN IF NOT EXISTS bundle_key text
    CHECK (bundle_key IS NULL OR bundle_key ~ '^plugin/[A-Za-z0-9][A-Za-z0-9_-]*$');
