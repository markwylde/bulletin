-- 0063: daily and weekly digest subscriptions and deliveries (ADR 0011).
--
-- The run records a delivery row and a delivery intent, then a job builds the content at send
-- time with current permissions. `last_sent_at` is the window start for the next digest.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.digest_subscriptions (
  member_id bigint PRIMARY KEY REFERENCES core.members (id) ON DELETE CASCADE,
  frequency text NOT NULL DEFAULT 'off' CHECK (frequency IN ('off', 'daily', 'weekly')),
  last_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.digest_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT digest_deliveries_period_key UNIQUE (member_id, frequency, period_end)
);

RESET ROLE;

GRANT SELECT ON core.digest_subscriptions, core.digest_deliveries TO user_app;
GRANT SELECT, INSERT, UPDATE ON core.digest_subscriptions TO user_api;
GRANT SELECT, INSERT, UPDATE ON core.digest_deliveries TO workers;
GRANT USAGE, SELECT ON core.digest_deliveries_id_seq TO workers;
GRANT SELECT ON core.digest_subscriptions, core.digest_deliveries TO pii_owner;
