-- 0092: bad-word filters, link limits and anti-spam rules (moderation 5.1/5.2; ADR 0007, 0011).
--
-- Replace rules are read at render time and their version feeds render_version. Block rules
-- veto saves. Link/spam settings are group settings (exemptions) plus one board row.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.filter_words (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  word text NOT NULL CHECK (char_length(btrim(word)) BETWEEN 1 AND 120),
  mode text NOT NULL CHECK (mode IN ('block', 'replace')),
  replacement text NOT NULL DEFAULT '' CHECK (char_length(replacement) <= 120),
  match_mode text NOT NULL DEFAULT 'whole' CHECK (match_mode IN ('whole', 'any')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT filter_replace_needs_text CHECK (mode <> 'replace' OR replacement <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS filter_words_word_mode_key
  ON core.filter_words (lower(word), mode);

CREATE TABLE IF NOT EXISTS core.filter_domains (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  domain text NOT NULL CHECK (domain ~ '^[a-z0-9.-]+$'),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT filter_domains_domain_key UNIQUE (domain)
);

CREATE TABLE IF NOT EXISTS core.filter_settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  version bigint NOT NULL DEFAULT 0,
  duplicate_enabled boolean NOT NULL DEFAULT false,
  duplicate_count integer NOT NULL DEFAULT 2 CHECK (duplicate_count BETWEEN 2 AND 100),
  duplicate_window_minutes integer NOT NULL DEFAULT 10 CHECK (duplicate_window_minutes BETWEEN 1 AND 1_440),
  rate_enabled boolean NOT NULL DEFAULT false,
  rate_count integer NOT NULL DEFAULT 5 CHECK (rate_count BETWEEN 2 AND 1_000),
  rate_minutes integer NOT NULL DEFAULT 1 CHECK (rate_minutes BETWEEN 1 AND 1_440),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO core.filter_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Duplicate history is short-lived and deliberately unlogged; the check is advisory and a
-- restart may only mean one missed duplicate rather than durable state.
CREATE UNLOGGED TABLE IF NOT EXISTS core.filter_duplicates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS filter_duplicates_lookup_idx
  ON core.filter_duplicates (author_id, body_hash, created_at DESC);

-- Filter management is an administrator section.
INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, 'acp.filters', to_jsonb(true)
FROM core.groups g
WHERE g.key = 'administrators'
ON CONFLICT (group_id, key) DO NOTHING;

RESET ROLE;

GRANT SELECT ON core.filter_words, core.filter_domains, core.filter_settings
  TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.filter_words, core.filter_domains, core.filter_settings
  TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.filter_words_id_seq, core.filter_domains_id_seq
  TO staff_api;
GRANT SELECT, INSERT, DELETE ON core.filter_duplicates TO user_api;
GRANT USAGE, SELECT ON SEQUENCE core.filter_duplicates_id_seq TO user_api;
