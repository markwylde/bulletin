-- 0125: API keys for `/api/v1` (ADR 0016) and their per-key/per-IP rate limits.
-- Keys are security records: only the prefix is stored in clear, never the key itself.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.board_settings
  ADD COLUMN IF NOT EXISTS api_key_rate_limit_per_minute integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS api_ip_rate_limit_per_minute integer NOT NULL DEFAULT 120;

ALTER TABLE core.board_settings
  DROP CONSTRAINT IF EXISTS board_settings_api_key_rate_limit_check,
  DROP CONSTRAINT IF EXISTS board_settings_api_ip_rate_limit_check;

ALTER TABLE core.board_settings
  ADD CONSTRAINT board_settings_api_key_rate_limit_check
    CHECK (api_key_rate_limit_per_minute BETWEEN 1 AND 10000),
  ADD CONSTRAINT board_settings_api_ip_rate_limit_check
    CHECK (api_ip_rate_limit_per_minute BETWEEN 1 AND 10000);

CREATE TABLE IF NOT EXISTS core.api_keys (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prefix text NOT NULL UNIQUE CHECK (prefix ~ '^[a-z0-9]{8}$'),
  hash bytea NOT NULL,
  principal_member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('personal', 'integration')),
  label text NOT NULL DEFAULT '',
  scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS api_keys_principal_idx
  ON core.api_keys (principal_member_id, created_at DESC);

RESET ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.api_keys TO user_api, staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.api_keys_id_seq TO user_api, staff_api;
