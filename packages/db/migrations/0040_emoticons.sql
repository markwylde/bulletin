-- 0040: staff-managed emoticon sets (ADR 0007).
--
-- Images are opaque storage keys; the database row is authoritative for the code, alt text,
-- order and editor visibility. A code is globally unique so `:code:` can never be ambiguous.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.emoticon_sets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  editor_visible boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.emoticons (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  set_id bigint NOT NULL REFERENCES core.emoticon_sets (id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_+-]{1,32}$'),
  alt text NOT NULL CHECK (char_length(btrim(alt)) BETWEEN 1 AND 100),
  storage_key text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS emoticons_set_idx ON core.emoticons (set_id, position, id);

INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, 'acp.emoticons', to_jsonb(true)
FROM core.groups g
WHERE g.key = 'administrators'
ON CONFLICT (group_id, key) DO NOTHING;

RESET ROLE;

GRANT SELECT ON core.emoticon_sets, core.emoticons TO user_app, user_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.emoticon_sets, core.emoticons TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.emoticon_sets_id_seq, core.emoticons_id_seq TO staff_api;
