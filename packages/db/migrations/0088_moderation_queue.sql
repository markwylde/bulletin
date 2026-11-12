-- 0088: moderation queue visibility, hold reasons and approval settings.
--
-- Held content lives in the same tables as everything else; `visibility` is authoritative and
-- counters/listings read only `visible` rows. `hold_reason` records why the queue holds an
-- item so the moderator view can explain it.

SET LOCAL ROLE bulletin_owner;

-- Topics carry their own visibility: a topic held by "new topics require approval" must stay
-- out of lists even though its first post is held too. Existing topics are visible.
ALTER TABLE core.topics
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'visible';
ALTER TABLE core.topics
  ADD COLUMN IF NOT EXISTS hold_reason text;

ALTER TABLE core.topics DROP CONSTRAINT IF EXISTS topics_visibility_check;
ALTER TABLE core.topics
  ADD CONSTRAINT topics_visibility_check
  CHECK (visibility IN ('visible', 'unapproved', 'soft_deleted'));

ALTER TABLE core.posts
  ADD COLUMN IF NOT EXISTS hold_reason text;

CREATE INDEX IF NOT EXISTS topics_forum_visibility_idx
  ON core.topics (forum_id, visibility, last_post_at DESC NULLS LAST, id DESC);

CREATE INDEX IF NOT EXISTS posts_topic_unapproved_idx
  ON core.posts (topic_id, position)
  WHERE visibility = 'unapproved';

-- Per-forum approval switches. Categories ignore them; a forum inherits nothing here, the
-- setting applies to its own topics and posts only.
ALTER TABLE core.forums
  ADD COLUMN IF NOT EXISTS require_approval_topics boolean NOT NULL DEFAULT false;
ALTER TABLE core.forums
  ADD COLUMN IF NOT EXISTS require_approval_posts boolean NOT NULL DEFAULT false;

-- Board-wide new-member approval: hold the first N approved posts and topics of a member.
-- Zero keeps the feature off, which is the default (ADR 0010 safety exemption, spec).
ALTER TABLE core.board_settings
  ADD COLUMN IF NOT EXISTS new_member_approval_posts integer NOT NULL DEFAULT 0;

ALTER TABLE core.board_settings
  DROP CONSTRAINT IF EXISTS board_new_member_approval_posts_check;
ALTER TABLE core.board_settings
  ADD CONSTRAINT board_new_member_approval_posts_check
  CHECK (new_member_approval_posts BETWEEN 0 AND 1000);

-- The staff app owns the same queue actions as the user app: approve flips visibility, and
-- reject deletes the held row and its attachment links (never a public counter).
GRANT UPDATE (visibility, hold_reason) ON core.posts TO staff_api;
GRANT DELETE ON core.posts, core.post_attachments TO staff_api;
GRANT UPDATE (expires_at) ON core.attachments TO staff_api;

RESET ROLE;
