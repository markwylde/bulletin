-- 0087: user-api may update attachment links when a reply reuses an upload
-- (conversations review finding P2; ADR 0019).
--
-- `syncConversationMessageAttachments` links an upload with `ON CONFLICT ... DO UPDATE`, and
-- Postgres checks the UPDATE privilege even when no row conflicts. Without it every reply with
-- an attachment fails under the production role and the whole reply rolls back.

GRANT UPDATE (position, inline) ON core.conversation_message_attachments TO user_api;
