-- 0057: in-app notifications (ADR 0011, 0012).
--
-- Notifications are personal content: the recipient can read their own rows, workers are the
-- only writer, and user-api marks them read. Each row carries IDs only; text is built at read
-- time in the recipient's locale (ADR 0013). The event key makes at-least-once event delivery
-- idempotent per recipient.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  type text NOT NULL,
  event_id bigint REFERENCES core.events (id) ON DELETE SET NULL,
  actor_id bigint REFERENCES core.members (id) ON DELETE SET NULL,
  topic_id bigint REFERENCES core.topics (id) ON DELETE CASCADE,
  forum_id bigint REFERENCES core.forums (id) ON DELETE CASCADE,
  post_id bigint REFERENCES core.posts (id) ON DELETE CASCADE,
  count integer NOT NULL DEFAULT 1 CHECK (count > 0),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_event_member_key UNIQUE (event_id, member_id)
);

-- The notification centre reads newest first; the bell reads the unread count.
CREATE INDEX IF NOT EXISTS notifications_member_created_idx
  ON core.notifications (member_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS notifications_member_unread_idx
  ON core.notifications (member_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS notifications_topic_unread_idx
  ON core.notifications (member_id, type, topic_id)
  WHERE read_at IS NULL;

RESET ROLE;

GRANT SELECT ON core.notifications TO user_app;
GRANT SELECT, UPDATE ON core.notifications TO user_api;
GRANT SELECT, INSERT, UPDATE ON core.notifications TO workers;
GRANT USAGE, SELECT ON SEQUENCE core.notifications_id_seq TO workers;
