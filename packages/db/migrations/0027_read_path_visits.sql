-- 0027: read-path visits and the personal overlay (ADR 0003, 0006, 0012).
-- Views, presence and rate counters are UNLOGGED and derived; read markers are durable and
-- written by user-api. `user_app` gets write access to the read-path buffers only.

SET LOCAL ROLE bulletin_owner;

-- One row per (topic, viewer, 30-minute bucket); the flush to view counts is the
-- `topics-posts` change's worker. No FK yet: the topics table lands in `forum-structure`.
CREATE UNLOGGED TABLE IF NOT EXISTS core.topic_view_buffer (
  topic_id bigint NOT NULL,
  viewer_key text NOT NULL,
  bucket timestamptz NOT NULL,
  PRIMARY KEY (topic_id, viewer_key, bucket)
);

CREATE INDEX IF NOT EXISTS topic_view_buffer_bucket_idx ON core.topic_view_buffer (bucket);

-- Who is online. Upserted at most once a minute per viewer (ADR 0006 read-path writes).
CREATE UNLOGGED TABLE IF NOT EXISTS core.presence (
  viewer_key text PRIMARY KEY,
  location text NOT NULL,
  last_seen timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS presence_last_seen_idx ON core.presence (last_seen);

-- Read markers: durable, member-scoped, written by user-api's overlay request.
CREATE TABLE IF NOT EXISTS core.topic_reads (
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  topic_id bigint NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  last_read_post_id bigint,
  PRIMARY KEY (member_id, topic_id)
);

-- Flood-control counters (ADR 0003): one row per key and time bucket.
CREATE UNLOGGED TABLE IF NOT EXISTS core.rate_buckets (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (key, window_start)
);

RESET ROLE;

-- The API records every member/guest visit; the read-path buffers are also writable by
-- user-app itself (ADR 0001 allows presence, views and redirect clicks there).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  core.topic_view_buffer, core.presence, core.rate_buckets, core.topic_reads
  TO user_api, staff_api, workers;
GRANT SELECT, INSERT, UPDATE ON core.topic_view_buffer, core.presence TO user_app;
GRANT SELECT ON core.rate_buckets, core.topic_reads TO user_app;
