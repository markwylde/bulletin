-- 0002: transactional outbox and pg-boss schema (ADR 0011, ADR 0003).

CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION workers;
ALTER SCHEMA pgboss OWNER TO workers;
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA pgboss TO workers;

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id bigint NOT NULL,
  aggregate_version bigint NOT NULL,
  payload_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX IF NOT EXISTS events_unpublished_idx
  ON core.events (id)
  WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS core.event_deliveries (
  event_id bigint NOT NULL REFERENCES core.events (id) ON DELETE CASCADE,
  subscriber text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, subscriber)
);

CREATE TABLE IF NOT EXISTS core.job_cursors (
  subscriber text PRIMARY KEY,
  last_event_id bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

RESET ROLE;

GRANT SELECT, INSERT ON core.events TO user_api, staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.events_id_seq TO user_api, staff_api, workers;
GRANT SELECT, UPDATE ON core.events TO workers;
GRANT SELECT, INSERT, UPDATE ON core.event_deliveries TO workers;
GRANT SELECT, INSERT, UPDATE ON core.job_cursors TO workers;
