-- 0106: repo-to-DB sync marker for the bundled default theme (ADR 0008, task 1.2).
-- Services compare the repository files' SHA-256 with this value at startup; a different
-- hash replaces the copy's templates and bumps the theme version. Child themes are untouched.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.themes
  ADD COLUMN IF NOT EXISTS source_hash text
  CHECK (source_hash IS NULL OR source_hash ~ '^[0-9a-f]{64}$');

RESET ROLE;
