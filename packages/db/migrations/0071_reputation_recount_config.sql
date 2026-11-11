-- 0071: remember which reaction configuration a recount rebuilt (design risk: settings change
-- while a big recount is interrupted). A resumed run compares this signature and rebuilds again
-- when the link or any weight moved on.

ALTER TABLE core.reputation_recounts
  ADD COLUMN IF NOT EXISTS config_hash text;
