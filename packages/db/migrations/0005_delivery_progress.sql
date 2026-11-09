-- 0005: remember which subscriber deliveries have been enqueued (ADR 0011).

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.event_deliveries
  ADD COLUMN IF NOT EXISTS enqueued_at timestamptz;
