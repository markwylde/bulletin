-- 0069: count distinct contributors for post-coalesced notifications (notifications spec).
--
-- Reaction events fire on changes as well as additions, so counting events would report one
-- member switching reactions three times as three people. The actor set gives the true number
-- of distinct members; reputation keeps its givers anonymous in the notification row itself
-- while still counting them here (ADR 0012).

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.notification_actors (
  notification_id bigint NOT NULL REFERENCES core.notifications (id) ON DELETE CASCADE,
  actor_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, actor_id)
);

RESET ROLE;

GRANT SELECT, INSERT, DELETE ON core.notification_actors TO workers;
