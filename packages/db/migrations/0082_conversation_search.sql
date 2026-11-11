-- 0082: full-text search inside a member's own conversations (conversations 2.3; ADR 0017).
--
-- The language config is stored per row and the query ORs the viewer's locale with `simple`,
-- so mixed-language private messages still match (ADR 0017). `simple` is the fallback when a
-- member has no locale.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.conversation_messages
  ADD COLUMN IF NOT EXISTS lang regconfig NOT NULL DEFAULT 'simple';

ALTER TABLE core.conversation_messages
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector(lang, body_text)) STORED;

CREATE INDEX IF NOT EXISTS conversation_messages_search_idx
  ON core.conversation_messages USING gin (search_vector);

ALTER TABLE core.conversations
  ADD COLUMN IF NOT EXISTS lang regconfig NOT NULL DEFAULT 'simple';

ALTER TABLE core.conversations
  ADD COLUMN IF NOT EXISTS title_search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector(lang, title)) STORED;

CREATE INDEX IF NOT EXISTS conversations_title_search_idx
  ON core.conversations USING gin (title_search_vector);

RESET ROLE;
