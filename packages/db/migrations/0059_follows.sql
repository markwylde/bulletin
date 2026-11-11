-- 0059: follows for topics, forums and members (ADR 0011, 0012).
--
-- Follows are personal content: only the follower and workers (notifications, digests) read
-- them, and only user-api writes them. One table per kind keeps real foreign keys, so deleting
-- content or a member removes the follow rows with it.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.followed_topics (
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  topic_id bigint NOT NULL REFERENCES core.topics (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, topic_id)
);

CREATE INDEX IF NOT EXISTS followed_topics_topic_idx ON core.followed_topics (topic_id);

CREATE TABLE IF NOT EXISTS core.followed_forums (
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  forum_id bigint NOT NULL REFERENCES core.forums (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, forum_id)
);

CREATE INDEX IF NOT EXISTS followed_forums_forum_idx ON core.followed_forums (forum_id);

CREATE TABLE IF NOT EXISTS core.followed_members (
  follower_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  followed_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CONSTRAINT followed_members_not_self_check CHECK (follower_id <> followed_id)
);

CREATE INDEX IF NOT EXISTS followed_members_followed_idx ON core.followed_members (followed_id);

-- Auto-follow defaults on when the member has no row (ADR 0011, follows spec).
CREATE TABLE IF NOT EXISTS core.follow_settings (
  member_id bigint PRIMARY KEY REFERENCES core.members (id) ON DELETE CASCADE,
  auto_follow_topics boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

RESET ROLE;

GRANT SELECT ON
  core.followed_topics, core.followed_forums, core.followed_members, core.follow_settings
  TO user_app, workers;

GRANT SELECT, INSERT, DELETE ON
  core.followed_topics, core.followed_forums, core.followed_members
  TO user_api;

GRANT SELECT, INSERT, UPDATE ON core.follow_settings TO user_api;
