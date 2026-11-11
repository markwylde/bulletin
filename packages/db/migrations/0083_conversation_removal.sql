-- 0083: retention holds and conversation attachments for permanent removal (conversations 2.4;
-- ADR 0011, 0012, 0019).
--
-- A hold is a generic reference from a report (or another retention reason) to one message.
-- Nothing creates holds until `moderation`; the conversation removal job keeps held messages and
-- their attachments until the last hold is released.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.conversation_message_holds (
  message_id bigint NOT NULL REFERENCES core.conversation_messages (id) ON DELETE CASCADE,
  -- A stable reason such as `report`; `ref` is the owning report/request ID.
  holder text NOT NULL CHECK (holder ~ '^[a-z][a-z0-9_]{0,31}$'),
  ref text NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, holder, ref)
);

CREATE INDEX IF NOT EXISTS conversation_message_holds_message_idx
  ON core.conversation_message_holds (message_id);

-- The conversation analogue of post_attachments. The upload path arrives in task 3.1; the
-- removal job already needs the links so it can delete the right objects.
CREATE TABLE IF NOT EXISTS core.conversation_message_attachments (
  message_id bigint NOT NULL REFERENCES core.conversation_messages (id) ON DELETE CASCADE,
  attachment_id bigint NOT NULL REFERENCES core.attachments (id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  inline boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS conversation_message_attachments_message_idx
  ON core.conversation_message_attachments (message_id, position, attachment_id);

CREATE INDEX IF NOT EXISTS conversation_message_attachments_attachment_idx
  ON core.conversation_message_attachments (attachment_id);

RESET ROLE;

-- Reading roles render conversation attachments; user-api owns the upload links (task 3.1).
GRANT SELECT ON core.conversation_message_attachments TO user_app, staff_api;
GRANT SELECT, INSERT, DELETE ON core.conversation_message_attachments TO user_api;

-- The removal worker deletes conversations, messages, links and objects. Moderation adds its
-- own INSERT/DELETE grant for holds when reports are implemented.
GRANT SELECT, UPDATE, DELETE ON core.conversations TO workers;
GRANT SELECT, DELETE ON core.conversation_participants,
  core.conversation_messages, core.conversation_message_attachments,
  core.conversation_message_holds TO workers;

-- The report access path (moderation) will insert and release holds; keep it out of user-api.
GRANT SELECT, INSERT, DELETE ON core.conversation_message_holds TO staff_api;
