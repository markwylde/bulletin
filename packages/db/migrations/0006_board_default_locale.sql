-- 0006: the board-wide default locale (ADR 0013).

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.board_settings
  ADD COLUMN IF NOT EXISTS default_locale text NOT NULL DEFAULT 'en';

ALTER TABLE core.board_settings
  DROP CONSTRAINT IF EXISTS board_settings_default_locale_check;

ALTER TABLE core.board_settings
  ADD CONSTRAINT board_settings_default_locale_check
  CHECK (default_locale IN ('en', 'es', 'fr'));

RESET ROLE;
