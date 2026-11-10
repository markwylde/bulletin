-- 0043: topics, posts, revisions, polls and read tracking (ADR 0001, 0005, 0006, 0007, 0012).
--
-- Topics and posts are the forum's core content. Positions are a stable insertion order under
-- the topic row lock, never a page number; visibility is authoritative (never a counter).
-- Counters and last-post pointers are maintained by the posting transactions.

SET LOCAL ROLE bulletin_owner;

-- ---------------------------------------------------------------------------------------------
-- Topics
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.topics (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  forum_id bigint NOT NULL REFERENCES core.forums (id),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 150),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  prefix_id bigint REFERENCES core.prefixes (id) ON DELETE SET NULL,
  starter_id bigint REFERENCES core.members (id) ON DELETE SET NULL,
  pinned boolean NOT NULL DEFAULT false,
  locked boolean NOT NULL DEFAULT false,
  reply_count integer NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  view_count bigint NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  -- Filled after `core.posts` exists (the two tables reference each other).
  first_post_id bigint,
  last_post_id bigint,
  last_post_at timestamptz,
  -- A moved-topic stub keeps the old forum row and points at the real topic (ADR 0001).
  moved_to bigint REFERENCES core.topics (id) ON DELETE CASCADE,
  stub_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS topics_forum_list_idx
  ON core.topics (forum_id, pinned DESC, last_post_at DESC NULLS LAST, id DESC);

CREATE INDEX IF NOT EXISTS topics_last_post_idx
  ON core.topics (last_post_at DESC NULLS LAST, id DESC);

CREATE INDEX IF NOT EXISTS topics_stub_expiry_idx
  ON core.topics (stub_expires_at)
  WHERE stub_expires_at IS NOT NULL;

-- A stub must point somewhere and expire; a real topic must not carry either marker.
ALTER TABLE core.topics DROP CONSTRAINT IF EXISTS topics_stub_check;
ALTER TABLE core.topics
  ADD CONSTRAINT topics_stub_check CHECK (
    (moved_to IS NULL AND stub_expires_at IS NULL)
    OR (moved_to IS NOT NULL AND stub_expires_at IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION core.topics_record_slug_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = core, public, pg_temp
AS $$
BEGIN
  IF OLD.slug <> '' AND OLD.slug IS DISTINCT FROM NEW.slug THEN
    INSERT INTO core.slug_history (kind, resource_id, slug)
    VALUES ('topic', OLD.id, OLD.slug);
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION core.topics_record_slug_history() FROM PUBLIC;

DROP TRIGGER IF EXISTS topics_record_slug_history ON core.topics;

CREATE TRIGGER topics_record_slug_history
AFTER UPDATE OF slug ON core.topics
FOR EACH ROW EXECUTE FUNCTION core.topics_record_slug_history();

-- ---------------------------------------------------------------------------------------------
-- Posts
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.posts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic_id bigint NOT NULL REFERENCES core.topics (id) ON DELETE CASCADE,
  -- Erasure may anonymise a member; a surviving post then has no author.
  author_id bigint REFERENCES core.members (id) ON DELETE SET NULL,
  body_md text NOT NULL,
  body_html text NOT NULL,
  body_text text NOT NULL,
  render_version integer NOT NULL CHECK (render_version > 0),
  sanitiser_version integer NOT NULL CHECK (sanitiser_version > 0),
  visibility text NOT NULL DEFAULT 'visible'
    CHECK (visibility IN ('visible', 'unapproved', 'soft_deleted')),
  -- Stable insertion order inside the topic, assigned under the topic row lock.
  position integer NOT NULL CHECK (position > 0),
  -- Forums whose readable content is quoted; the topic route declares their `read` bits
  -- before its cache lookup (ADR 0005).
  quoted_forum_ids bigint[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  edited_by bigint REFERENCES core.members (id) ON DELETE SET NULL,
  CONSTRAINT posts_topic_position_key UNIQUE (topic_id, position)
);

-- Pagination and permalink page computation count visible posts before a position.
CREATE INDEX IF NOT EXISTS posts_topic_visible_idx
  ON core.posts (topic_id, visibility, position);

CREATE INDEX IF NOT EXISTS posts_author_idx
  ON core.posts (author_id);

CREATE INDEX IF NOT EXISTS posts_created_idx
  ON core.posts (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS posts_quoted_forums_idx
  ON core.posts USING gin (quoted_forum_ids);

-- The first/last-post pointers are FKs only now that posts exist. Deleting a first post
-- requires deleting the topic (enforced by the domain), so SET NULL is a safety net.
ALTER TABLE core.topics DROP CONSTRAINT IF EXISTS topics_first_post_fk;
ALTER TABLE core.topics
  ADD CONSTRAINT topics_first_post_fk
  FOREIGN KEY (first_post_id) REFERENCES core.posts (id) ON DELETE SET NULL;

ALTER TABLE core.topics DROP CONSTRAINT IF EXISTS topics_last_post_fk;
ALTER TABLE core.topics
  ADD CONSTRAINT topics_last_post_fk
  FOREIGN KEY (last_post_id) REFERENCES core.posts (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------------------------
-- Post revisions (edit history)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.post_revisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id bigint NOT NULL REFERENCES core.posts (id) ON DELETE CASCADE,
  body_md text NOT NULL,
  body_html text NOT NULL,
  body_text text NOT NULL,
  render_version integer NOT NULL CHECK (render_version > 0),
  sanitiser_version integer NOT NULL CHECK (sanitiser_version > 0),
  editor_id bigint REFERENCES core.members (id) ON DELETE SET NULL,
  edited_at timestamptz NOT NULL,
  -- A redacting moderator edit hides every earlier version from public history (ADR 0007).
  protected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS post_revisions_post_idx
  ON core.post_revisions (post_id, id);

CREATE INDEX IF NOT EXISTS post_revisions_protected_idx
  ON core.post_revisions (post_id)
  WHERE protected;

-- ---------------------------------------------------------------------------------------------
-- Polls
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.polls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic_id bigint NOT NULL UNIQUE REFERENCES core.topics (id) ON DELETE CASCADE,
  results_visible_before_voting boolean NOT NULL DEFAULT false,
  closes_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS polls_close_idx
  ON core.polls (closes_at)
  WHERE closes_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.poll_questions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  poll_id bigint NOT NULL REFERENCES core.polls (id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  prompt text NOT NULL CHECK (char_length(btrim(prompt)) BETWEEN 1 AND 500),
  multiple boolean NOT NULL DEFAULT false,
  CONSTRAINT poll_questions_poll_id_key UNIQUE (poll_id, id)
);

CREATE INDEX IF NOT EXISTS poll_questions_poll_idx
  ON core.poll_questions (poll_id, position, id);

CREATE TABLE IF NOT EXISTS core.poll_choices (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  poll_id bigint NOT NULL,
  question_id bigint NOT NULL,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 300),
  CONSTRAINT poll_choices_question_fk
    FOREIGN KEY (poll_id, question_id)
    REFERENCES core.poll_questions (poll_id, id) ON DELETE CASCADE,
  CONSTRAINT poll_choices_identity_key UNIQUE (poll_id, question_id, id)
);

CREATE INDEX IF NOT EXISTS poll_choices_question_idx
  ON core.poll_choices (question_id, position, id);

CREATE TABLE IF NOT EXISTS core.poll_votes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  poll_id bigint NOT NULL REFERENCES core.polls (id) ON DELETE CASCADE,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT poll_votes_once_key UNIQUE (poll_id, member_id)
);

CREATE TABLE IF NOT EXISTS core.poll_vote_choices (
  poll_id bigint NOT NULL,
  member_id bigint NOT NULL,
  question_id bigint NOT NULL,
  choice_id bigint NOT NULL,
  PRIMARY KEY (poll_id, member_id, question_id, choice_id),
  CONSTRAINT poll_vote_choices_vote_fk
    FOREIGN KEY (poll_id, member_id)
    REFERENCES core.poll_votes (poll_id, member_id) ON DELETE CASCADE,
  CONSTRAINT poll_vote_choices_choice_fk
    FOREIGN KEY (poll_id, question_id, choice_id)
    REFERENCES core.poll_choices (poll_id, question_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS poll_vote_choices_choice_idx
  ON core.poll_vote_choices (choice_id);

-- ---------------------------------------------------------------------------------------------
-- Read tracking
-- ---------------------------------------------------------------------------------------------

-- `topic_reads` and `topic_view_buffer` arrived with the read-path migration. They stay
-- deliberately unconstrained: views and markers are recorded for topics that may already be
-- gone (a cached or CDN-served page, a delete racing the flush) and must not fail the request.

CREATE INDEX IF NOT EXISTS topic_reads_member_idx
  ON core.topic_reads (member_id, last_read_at DESC);

CREATE TABLE IF NOT EXISTS core.forum_reads (
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  forum_id bigint NOT NULL REFERENCES core.forums (id) ON DELETE CASCADE,
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, forum_id)
);

CREATE INDEX IF NOT EXISTS forum_reads_member_idx
  ON core.forum_reads (member_id, marked_at DESC);

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS post_count integer NOT NULL DEFAULT 0;

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS board_marked_at timestamptz;

ALTER TABLE core.members DROP CONSTRAINT IF EXISTS members_post_count_check;
ALTER TABLE core.members
  ADD CONSTRAINT members_post_count_check CHECK (post_count >= 0);

RESET ROLE;

-- Reading roles see topics, posts, polls and read markers. Only user-api writes content.
GRANT SELECT ON
  core.topics, core.posts, core.post_revisions, core.polls, core.poll_questions,
  core.poll_choices, core.poll_votes, core.poll_vote_choices, core.forum_reads
  TO user_app, user_api, staff_api, workers;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  core.topics, core.posts, core.post_revisions, core.polls, core.poll_questions,
  core.poll_choices, core.poll_votes, core.poll_vote_choices, core.forum_reads
  TO user_api;

GRANT USAGE, SELECT ON
  core.topics_id_seq, core.posts_id_seq, core.post_revisions_id_seq, core.polls_id_seq,
  core.poll_questions_id_seq, core.poll_choices_id_seq, core.poll_votes_id_seq
  TO user_api;

-- The content re-render worker owns only the derived rendering columns (ADR 0007).
GRANT UPDATE (
  body_html, body_text, render_version, sanitiser_version
) ON core.posts TO workers;
