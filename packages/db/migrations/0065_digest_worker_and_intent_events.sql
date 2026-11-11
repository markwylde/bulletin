-- 0065: digest worker access and event-scoped email intents (ADR 0011, 0012).
--
-- The scheduler reads digest subscriptions and the delivery job advances last_sent_at, both as
-- the workers role. Notification email intents deduplicate by their source event, not only by
-- the coalesced notification row, so every reply can still be emailed after an earlier send.

GRANT SELECT ON core.digest_subscriptions TO workers;
GRANT UPDATE (last_sent_at, updated_at) ON core.digest_subscriptions TO workers;

ALTER TABLE core.delivery_intents
  ADD COLUMN IF NOT EXISTS source_event_id bigint REFERENCES core.events (id) ON DELETE CASCADE;

ALTER TABLE core.delivery_intents DROP CONSTRAINT IF EXISTS delivery_intents_unique;

CREATE UNIQUE INDEX IF NOT EXISTS delivery_intents_source_key
  ON core.delivery_intents (kind, ref_id, channel, coalesce(source_event_id, 0));
