-- 0061: per-type notification preferences (notifications spec, ADR 0011).
--
-- One row per member/type/channel that differs from the defaults: in-app and email on,
-- digest off. The centre and the bell read in_app; email delivery reads email at send time.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.notification_preferences (
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  type text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'digest')),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, type, channel)
);

RESET ROLE;

GRANT SELECT ON core.notification_preferences TO user_app, workers;
GRANT SELECT, INSERT, UPDATE ON core.notification_preferences TO user_api;
