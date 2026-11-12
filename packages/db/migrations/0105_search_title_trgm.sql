-- 0105: fuzzy topic-title matching (ADR 0017). The trigram extension already exists from
-- 0103; this index backs the case-insensitive `%` match used when a query has a typo.

SET LOCAL ROLE bulletin_owner;

CREATE INDEX IF NOT EXISTS topics_title_trgm_idx
  ON core.topics USING gin (lower(title) gin_trgm_ops);

RESET ROLE;
