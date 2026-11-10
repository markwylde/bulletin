-- 0032: global and forum announcements (ADR 0006, 0012).
--
-- `scope = 'global'` announcements have no target rows and appear everywhere; forum
-- announcements list one `announcement_targets` row per forum, optionally including its
-- subtree. Empty `announcement_groups` means "everyone"; otherwise the rows are the audience.
-- Dismissals store the announcement version the member dismissed, so editing the content
-- brings the announcement back (task `announcements`).

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.announcements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL CHECK (char_length(btrim(title)) > 0),
  body text NOT NULL DEFAULT '',
  scope text NOT NULL DEFAULT 'forums' CHECK (scope IN ('global', 'forums')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  dismissible boolean NOT NULL DEFAULT true,
  created_by bigint REFERENCES core.members (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcements_window_check CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS announcements_window_idx ON core.announcements (starts_at, ends_at);

CREATE TABLE IF NOT EXISTS core.announcement_targets (
  announcement_id bigint NOT NULL REFERENCES core.announcements (id) ON DELETE CASCADE,
  forum_id bigint NOT NULL REFERENCES core.forums (id) ON DELETE CASCADE,
  include_subforums boolean NOT NULL DEFAULT true,
  PRIMARY KEY (announcement_id, forum_id)
);

CREATE INDEX IF NOT EXISTS announcement_targets_forum_idx
  ON core.announcement_targets (forum_id);

CREATE TABLE IF NOT EXISTS core.announcement_groups (
  announcement_id bigint NOT NULL REFERENCES core.announcements (id) ON DELETE CASCADE,
  group_id bigint NOT NULL REFERENCES core.groups (id) ON DELETE CASCADE,
  PRIMARY KEY (announcement_id, group_id)
);

CREATE INDEX IF NOT EXISTS announcement_groups_group_idx
  ON core.announcement_groups (group_id);

CREATE TABLE IF NOT EXISTS core.announcement_dismissals (
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  announcement_id bigint NOT NULL REFERENCES core.announcements (id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, announcement_id)
);

CREATE INDEX IF NOT EXISTS announcement_dismissals_announcement_idx
  ON core.announcement_dismissals (announcement_id);

-- Editing the visible content is a new version: everyone who dismissed the old one sees it
-- again. Schedule and audience edits do not bump the version.
CREATE OR REPLACE FUNCTION core.announcements_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = core, public, pg_temp
AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title OR NEW.body IS DISTINCT FROM OLD.body THEN
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION core.announcements_touch() FROM PUBLIC;

DROP TRIGGER IF EXISTS announcements_touch ON core.announcements;

CREATE TRIGGER announcements_touch
BEFORE UPDATE ON core.announcements
FOR EACH ROW EXECUTE FUNCTION core.announcements_touch();

RESET ROLE;

GRANT SELECT ON core.announcements, core.announcement_targets, core.announcement_groups
  TO user_app, user_api, workers;

GRANT SELECT ON core.announcement_dismissals TO user_app, workers;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.announcements, core.announcement_targets,
  core.announcement_groups TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.announcements_id_seq TO staff_api;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.announcement_dismissals TO user_api;
