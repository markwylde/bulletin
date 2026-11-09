-- 0011: track re-auth retries during an identity-provider outage (ADR 0018).
-- A network failure extends reauth_at by one hour, at most three times.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.sessions
  ADD COLUMN IF NOT EXISTS reauth_retry_count integer NOT NULL DEFAULT 0;

ALTER TABLE core.sessions
  DROP CONSTRAINT IF EXISTS sessions_reauth_retry_count_check;

ALTER TABLE core.sessions
  ADD CONSTRAINT sessions_reauth_retry_count_check
  CHECK (reauth_retry_count >= 0);

RESET ROLE;
