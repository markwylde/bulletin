-- 0048: keep view dedupe rows after their count has been flushed (ADR 0006).
-- `flushed_at` marks a buffered view already added to `topics.view_count`; the row survives
-- until the 30-minute dedupe bucket expires so repeat views in the same window stay one view.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.topic_view_buffer
  ADD COLUMN IF NOT EXISTS flushed_at timestamptz;

CREATE INDEX IF NOT EXISTS topic_view_buffer_pending_idx
  ON core.topic_view_buffer (topic_id)
  WHERE flushed_at IS NULL;

RESET ROLE;
