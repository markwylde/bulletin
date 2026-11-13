-- 0126: outbound webhooks, their configuration and per-attempt delivery log (ADR 0016).
-- Secrets are security records readable only by staff-api and workers; no app role may
-- browse another table's content through these rows.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.webhooks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  url text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
  secret text NOT NULL CHECK (char_length(secret) >= 32),
  events text[] NOT NULL CHECK (cardinality(events) > 0),
  principal_member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  content_fields text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES core.members (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  failure_since timestamptz,
  disabled_at timestamptz,
  disabled_reason text
);

CREATE INDEX IF NOT EXISTS webhooks_principal_idx
  ON core.webhooks (principal_member_id);

CREATE INDEX IF NOT EXISTS webhooks_enabled_idx
  ON core.webhooks (created_at)
  WHERE enabled;

CREATE TABLE IF NOT EXISTS core.webhook_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_id bigint NOT NULL REFERENCES core.webhooks (id) ON DELETE CASCADE,
  event_id bigint NOT NULL REFERENCES core.events (id) ON DELETE CASCADE,
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL CHECK (status IN ('pending', 'delivered', 'failed', 'skipped')),
  http_status integer,
  response_ms integer,
  error text,
  signature_timestamp timestamptz,
  enqueued_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT webhook_deliveries_attempt_key UNIQUE (webhook_id, event_id, attempt)
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_idx
  ON core.webhook_deliveries (webhook_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS webhook_deliveries_pending_idx
  ON core.webhook_deliveries (created_at, id)
  WHERE status = 'pending' AND enqueued_at IS NULL;

-- Administrators manage outbound integrations; the typed registry exposes the same grant in
-- the group settings matrix.
INSERT INTO core.group_settings (group_id, key, value)
SELECT id, 'acp.webhooks', to_jsonb(true)
FROM core.groups
WHERE key = 'administrators'
ON CONFLICT (group_id, key) DO NOTHING;

RESET ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.webhooks TO staff_api, workers;
GRANT USAGE, SELECT ON SEQUENCE core.webhooks_id_seq TO staff_api, workers;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.webhook_deliveries TO staff_api, workers;
GRANT USAGE, SELECT ON SEQUENCE core.webhook_deliveries_id_seq TO staff_api, workers;
