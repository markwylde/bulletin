-- 0084: conversation notifications (conversations 3.2; ADR 0011, 0012).
--
-- A PM notification points at a conversation, never at a topic or post. One unread entry per
-- (member, type, conversation) coalesces several replies until the member reads it.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.notifications
  ADD COLUMN IF NOT EXISTS conversation_id bigint
    REFERENCES core.conversations (id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_unread_conversation_key
  ON core.notifications (member_id, type, conversation_id)
  WHERE read_at IS NULL
    AND conversation_id IS NOT NULL
    AND type = 'conversation.message';

CREATE INDEX IF NOT EXISTS notifications_conversation_idx
  ON core.notifications (conversation_id);

RESET ROLE;
