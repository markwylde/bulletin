-- 0055: guest attachment download counts as an UNLOGGED read-path buffer (ADR 0001, 0006).
--
-- user-app records one row per attachment/viewer/minute (the primary key is the rate limit);
-- the worker folds the counts into core.attachments.download_count and bumps post tags.

SET LOCAL ROLE bulletin_owner;

CREATE UNLOGGED TABLE IF NOT EXISTS core.attachment_download_buffer (
  attachment_id bigint NOT NULL REFERENCES core.attachments (id) ON DELETE CASCADE,
  viewer_key text NOT NULL,
  bucket timestamptz NOT NULL,
  PRIMARY KEY (attachment_id, viewer_key, bucket)
);

CREATE INDEX IF NOT EXISTS attachment_download_buffer_bucket_idx
  ON core.attachment_download_buffer (bucket);

RESET ROLE;

GRANT INSERT, SELECT, DELETE ON core.attachment_download_buffer TO user_app, workers;
