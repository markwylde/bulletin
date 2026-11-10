-- 0044: board paging and edit-history settings (topics-posts).
--
-- The topic list and topic view page size are board settings (spec topics: paging). Public
-- edit history is the board switch the post history view reads (spec posts: edit history).

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.board_settings
  ADD COLUMN IF NOT EXISTS topics_per_page integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS posts_per_page integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS public_edit_history boolean NOT NULL DEFAULT false;

ALTER TABLE core.board_settings DROP CONSTRAINT IF EXISTS board_topics_per_page_check;
ALTER TABLE core.board_settings
  ADD CONSTRAINT board_topics_per_page_check CHECK (topics_per_page BETWEEN 1 AND 100);

ALTER TABLE core.board_settings DROP CONSTRAINT IF EXISTS board_posts_per_page_check;
ALTER TABLE core.board_settings
  ADD CONSTRAINT board_posts_per_page_check CHECK (posts_per_page BETWEEN 1 AND 100);

RESET ROLE;
