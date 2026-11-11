-- 0068: coalesce reaction and reputation notifications per post (notifications spec).
--
-- Replies, mentions and quotes still coalesce per topic while unread. Reactions and reputation
-- are about one post, so three people reacting to the same post become one entry with count 3,
-- and reactions on different posts stay separate entries.

DROP INDEX IF EXISTS core.notifications_unread_topic_key;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_unread_topic_key
  ON core.notifications (member_id, type, topic_id)
  WHERE read_at IS NULL
    AND topic_id IS NOT NULL
    AND type NOT IN ('reaction.added', 'reputation.given');

CREATE UNIQUE INDEX IF NOT EXISTS notifications_unread_post_key
  ON core.notifications (member_id, type, post_id)
  WHERE read_at IS NULL
    AND post_id IS NOT NULL
    AND type IN ('reaction.added', 'reputation.given');
