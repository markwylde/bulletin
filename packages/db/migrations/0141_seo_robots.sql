-- 0141: admin-managed robots.txt (change seo-feeds, task 2.2).
-- Empty means the app serves its generated default; an admin can replace the whole file.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.board_settings
  ADD COLUMN IF NOT EXISTS robots_txt text NOT NULL DEFAULT '';

ALTER TABLE core.board_settings
  DROP CONSTRAINT IF EXISTS board_settings_robots_txt_length;

ALTER TABLE core.board_settings
  ADD CONSTRAINT board_settings_robots_txt_length
    CHECK (length(robots_txt) <= 65535);

RESET ROLE;
