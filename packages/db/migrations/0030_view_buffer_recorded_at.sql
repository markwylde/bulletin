-- 0030: remember when a view was actually recorded (ADR 0006, 0012). The 30-minute dedupe
-- bucket is its rounded start, so expiring on the bucket time deletes a visit made late in the
-- bucket almost immediately; the maintenance sweep now keeps rows until the bucket that holds
-- them has ended, while `recorded_at` keeps the true visit time available.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.topic_view_buffer
  ADD COLUMN IF NOT EXISTS recorded_at timestamptz NOT NULL DEFAULT now();

RESET ROLE;
