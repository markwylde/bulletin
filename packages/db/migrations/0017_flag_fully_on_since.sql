-- 0017: track how long a flag has been fully on, independently of `updated_at` (ADR 0010).
-- Staleness highlights are based on `fully_on_since`, so an identical save or an edit that
-- keeps the flag fully enabled does not hide "ready for removal".

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.feature_flags
  ADD COLUMN IF NOT EXISTS fully_on_since timestamptz;

-- Conservative backfill: a default-on flag with no rules is fully on for every viewer.
-- Rows with rules keep a null start until the staff app next saves them, where the
-- evaluation-aware check sets or preserves the instant.
UPDATE core.feature_flags
SET fully_on_since = updated_at
WHERE fully_on_since IS NULL
  AND default_value = true
  AND rules = '[]'::jsonb;

RESET ROLE;
