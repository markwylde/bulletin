-- 0037: admin-configured embed providers and the unfurl cache (ADR 0007, 0011, 0016).
--
-- Provider patterns capture the platform id in group 1; `embed_url` is an HTTPS template with
-- `{id}`. Renders only use these rows, never URLs from member content. The unfurl worker stores
-- text-only previews; images arrive with `attachments-avatars` (ADR 0019).

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.embed_providers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),
  url_pattern text NOT NULL CHECK (char_length(url_pattern) BETWEEN 1 AND 500),
  embed_url text NOT NULL CHECK (embed_url ~ '^https://'),
  enabled boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS embed_providers_enabled_idx
  ON core.embed_providers (enabled, position, id);

INSERT INTO core.embed_providers (key, title, url_pattern, embed_url, position)
VALUES
  (
    'youtube',
    'YouTube',
    $re$^https?://(?:www\.)?(?:youtube\.com/(?:watch\?v=|shorts/)|youtu\.be/)([A-Za-z0-9_-]{6,64})(?:[?&#/].*)?$$re$,
    'https://www.youtube-nocookie.com/embed/{id}',
    0
  ),
  (
    'vimeo',
    'Vimeo',
    $re$^https?://(?:www\.)?vimeo\.com/(\d{3,12})(?:[/?#].*)?$$re$,
    'https://player.vimeo.com/video/{id}',
    1
  )
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS core.unfurls (
  url_hash text PRIMARY KEY CHECK (url_hash ~ '^[0-9a-f]{64}$'),
  url text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'blocked', 'failed')),
  preview jsonb,
  fetched_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS unfurls_refresh_idx
  ON core.unfurls (status, updated_at);

RESET ROLE;

GRANT SELECT ON core.embed_providers, core.unfurls TO user_app, user_api, staff_api, workers;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.embed_providers TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.embed_providers_id_seq TO staff_api;

GRANT SELECT, INSERT, UPDATE ON core.unfurls TO user_api, staff_api, workers;
