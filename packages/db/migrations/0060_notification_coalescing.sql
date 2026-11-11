-- 0060: notification coalescing and mention/quote recipients (ADR 0011).
--
-- One unread notification per (member, type, topic) with a count, so several replies become
-- one entry. `notification_events` is the at-least-once dedupe key per event and recipient, so
-- a retried job never increments a count twice. Posts remember the members they mention and the
-- posts they quote, so the subscriber needs no content parsing.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.notifications DROP CONSTRAINT IF EXISTS notifications_event_member_key;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_unread_topic_key
  ON core.notifications (member_id, type, topic_id)
  WHERE read_at IS NULL AND topic_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS notifications_member_updated_idx
  ON core.notifications (member_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS core.notification_events (
  event_id bigint NOT NULL REFERENCES core.events (id) ON DELETE CASCADE,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  notification_id bigint REFERENCES core.notifications (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, member_id)
);

CREATE INDEX IF NOT EXISTS notification_events_notification_idx
  ON core.notification_events (notification_id);

ALTER TABLE core.posts
  ADD COLUMN IF NOT EXISTS mentioned_member_ids bigint[] NOT NULL DEFAULT '{}';

ALTER TABLE core.posts
  ADD COLUMN IF NOT EXISTS quoted_post_ids bigint[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS posts_mentioned_members_idx
  ON core.posts USING gin (mentioned_member_ids);

CREATE INDEX IF NOT EXISTS posts_quoted_posts_idx
  ON core.posts USING gin (quoted_post_ids);

RESET ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.notification_events TO workers;
