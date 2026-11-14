-- 0141: W3C trace context on outbox events (ADR 0020, operations-observability task 1.2).
-- The relay continues the writer's trace from this column and passes it on in job data. It is
-- a random trace identifier, never personal data.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.events ADD COLUMN IF NOT EXISTS trace_parent text
  CHECK (trace_parent IS NULL OR trace_parent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');

COMMENT ON COLUMN core.events.trace_parent
  IS 'W3C traceparent of the write that emitted the event; not personal data';

RESET ROLE;
