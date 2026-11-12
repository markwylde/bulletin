-- 0102: soft deletion remembers whether the row was public or held.
--
-- A moderator may have `soft_delete` and `restore` without `approve`. Deleting a held topic
-- or post must not turn it into an ordinary deleted row whose restore publishes it: the
-- restore target is the visibility the row had before deletion. Existing deleted rows are
-- treated as previously visible, which is what the old code assumed.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.topics
  ADD COLUMN IF NOT EXISTS restore_visibility text NOT NULL DEFAULT 'visible';

ALTER TABLE core.topics DROP CONSTRAINT IF EXISTS topics_restore_visibility_check;
ALTER TABLE core.topics
  ADD CONSTRAINT topics_restore_visibility_check
  CHECK (restore_visibility IN ('visible', 'unapproved'));

ALTER TABLE core.posts
  ADD COLUMN IF NOT EXISTS restore_visibility text NOT NULL DEFAULT 'visible';

ALTER TABLE core.posts DROP CONSTRAINT IF EXISTS posts_restore_visibility_check;
ALTER TABLE core.posts
  ADD CONSTRAINT posts_restore_visibility_check
  CHECK (restore_visibility IN ('visible', 'unapproved'));

RESET ROLE;
