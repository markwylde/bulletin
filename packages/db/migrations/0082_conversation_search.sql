-- 0082: full-text search inside a member's own conversations (conversations 2.3; ADR 0017).
--
-- `simple` is language-neutral: a private message may be in en, es or fr, and ADR 0017's
-- configurable stemming must not hide literal words in another language.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.conversation_messages
  ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', body_text)) STORED;

CREATE INDEX IF NOT EXISTS conversation_messages_search_idx
  ON core.conversation_messages USING gin (search_vector);

ALTER TABLE core.conversations
  ADD COLUMN IF NOT EXISTS title_search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', title)) STORED;

CREATE INDEX IF NOT EXISTS conversations_title_search_idx
  ON core.conversations USING gin (title_search_vector);

RESET ROLE;
