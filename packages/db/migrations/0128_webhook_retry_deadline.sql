-- 0128: durable retry deadlines for webhook attempts. A failed attempt and its successor are
-- committed together, so a worker crash after the HTTP request cannot lose the retry.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.webhook_deliveries
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS webhook_deliveries_scheduled_idx
  ON core.webhook_deliveries (scheduled_at, created_at, id)
  WHERE status = 'pending' AND enqueued_at IS NULL;

RESET ROLE;
