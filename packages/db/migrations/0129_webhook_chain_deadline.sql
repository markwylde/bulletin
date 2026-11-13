-- 0129: each webhook delivery chain has its own 24-hour retry deadline. Webhook-wide
-- `failure_since` still drives auto-disable, but an unrelated success must not extend a
-- persistently failing event's retry window.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.webhook_deliveries
  ADD COLUMN IF NOT EXISTS retry_deadline timestamptz NOT NULL
    DEFAULT (now() + interval '24 hours');

RESET ROLE;
