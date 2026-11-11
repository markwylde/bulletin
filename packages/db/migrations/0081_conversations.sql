-- 0081: private conversations: model and participant-only access (conversations 1.1, 1.2;
-- ADR 0001, 0006, 0011, 0012).
--
-- Conversations are personal content. Reads go through `conversation_participants` with
-- `state = 'active'`; there is deliberately no staff grant and no staff bypass. The `left` and
-- `removed` rows survive only to enforce `block_reinvite` (design).

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.conversations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL,
  starter_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_title_length_check
    CHECK (char_length(btrim(title)) BETWEEN 3 AND 150)
);

CREATE INDEX IF NOT EXISTS conversations_starter_created_idx
  ON core.conversations (starter_id, created_at DESC);

CREATE INDEX IF NOT EXISTS conversations_last_message_idx
  ON core.conversations (last_message_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS core.conversation_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES core.conversations (id) ON DELETE CASCADE,
  author_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  body_md text NOT NULL CHECK (btrim(body_md) <> ''),
  body_html text NOT NULL,
  body_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_messages_conversation_idx
  ON core.conversation_messages (conversation_id, id);

CREATE TABLE IF NOT EXISTS core.conversation_participants (
  conversation_id bigint NOT NULL REFERENCES core.conversations (id) ON DELETE CASCADE,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'left', 'removed')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  last_read_message_id bigint REFERENCES core.conversation_messages (id) ON DELETE SET NULL,
  folder text NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox', 'archive')),
  block_reinvite boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, member_id),
  -- Every former participant has a timestamp; an active one never does.
  CONSTRAINT conversation_participants_left_check CHECK (
    (state = 'active' AND left_at IS NULL) OR (state <> 'active' AND left_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS conversation_participants_member_idx
  ON core.conversation_participants (member_id, state, folder, conversation_id);

CREATE INDEX IF NOT EXISTS conversation_participants_conversation_idx
  ON core.conversation_participants (conversation_id, state, member_id);

RESET ROLE;

-- user_app renders conversation pages; user_api owns every write. staff_api gets nothing:
-- staff read conversations only through the moderation report access path (design).
GRANT SELECT ON core.conversations, core.conversation_participants,
  core.conversation_messages TO user_app;

GRANT SELECT, INSERT, UPDATE ON core.conversations TO user_api;
GRANT SELECT, INSERT, UPDATE ON core.conversation_participants TO user_api;
GRANT SELECT, INSERT, UPDATE ON core.conversation_messages TO user_api;

GRANT USAGE, SELECT ON SEQUENCE core.conversations_id_seq TO user_api;
GRANT USAGE, SELECT ON SEQUENCE core.conversation_messages_id_seq TO user_api;
