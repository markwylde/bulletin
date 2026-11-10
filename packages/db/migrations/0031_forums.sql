-- 0031: the category/forum tree, per-forum settings, prefixes and slug history
-- (ADR 0001, 0005, 0006).
--
-- The adjacency list (`parent_id`, `position`) stays the source of truth; the materialised
-- `path ltree` exists for ancestor and descendant queries (the announcement audience and the
-- admin screen use it). A move rewrites the subtree's paths in the same transaction, and a
-- move under the node's own descendant is rejected by the trigger.

CREATE EXTENSION IF NOT EXISTS ltree;

SET LOCAL ROLE bulletin_owner;

-- ---------------------------------------------------------------------------------------------
-- Forums: type, names, paths and per-forum settings
-- ---------------------------------------------------------------------------------------------

ALTER TABLE core.forums
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'forum',
  ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS slug text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS path ltree,
  ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS rules text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS redirect_url text,
  ADD COLUMN IF NOT EXISTS redirect_clicks bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS show_moderators boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS default_sort text NOT NULL DEFAULT 'last_post',
  ADD COLUMN IF NOT EXISTS language text,
  ADD COLUMN IF NOT EXISTS prefix_mode text NOT NULL DEFAULT 'optional',
  ADD COLUMN IF NOT EXISTS topic_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS post_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_topic_id bigint,
  ADD COLUMN IF NOT EXISTS last_post_id bigint,
  ADD COLUMN IF NOT EXISTS last_post_member_id bigint,
  ADD COLUMN IF NOT EXISTS last_post_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE core.forums DROP CONSTRAINT IF EXISTS forums_type_check;
ALTER TABLE core.forums
  ADD CONSTRAINT forums_type_check CHECK (type IN ('category', 'forum', 'redirect'));

ALTER TABLE core.forums DROP CONSTRAINT IF EXISTS forums_slug_check;
ALTER TABLE core.forums
  ADD CONSTRAINT forums_slug_check
  CHECK (slug = '' OR slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE core.forums DROP CONSTRAINT IF EXISTS forums_redirect_url_check;
ALTER TABLE core.forums
  ADD CONSTRAINT forums_redirect_url_check CHECK (
    (type = 'redirect' AND redirect_url ~ '^https?://')
    OR (type <> 'redirect' AND redirect_url IS NULL)
  );

ALTER TABLE core.forums DROP CONSTRAINT IF EXISTS forums_prefix_mode_check;
ALTER TABLE core.forums
  ADD CONSTRAINT forums_prefix_mode_check
  CHECK (prefix_mode IN ('none', 'optional', 'required'));

ALTER TABLE core.forums DROP CONSTRAINT IF EXISTS forums_default_sort_check;
ALTER TABLE core.forums
  ADD CONSTRAINT forums_default_sort_check
  CHECK (default_sort IN ('last_post', 'start_date', 'title'));

ALTER TABLE core.forums DROP CONSTRAINT IF EXISTS forums_language_check;
ALTER TABLE core.forums
  ADD CONSTRAINT forums_language_check
  CHECK (language IS NULL OR language ~ '^[a-z]{2}(-[A-Z]{2})?$');

ALTER TABLE core.forums DROP CONSTRAINT IF EXISTS forums_counters_check;
ALTER TABLE core.forums
  ADD CONSTRAINT forums_counters_check CHECK (
    position >= 0
    AND topic_count >= 0
    AND post_count >= 0
    AND redirect_clicks >= 0
  );

-- Existing rows (the permission fixtures) get display names and slugs so the tree manager
-- and the index have something to show. Real content comes from the forum seed.
UPDATE core.forums
SET title = CASE WHEN type = 'category' THEN 'Category ' ELSE 'Forum ' END || id
WHERE btrim(title) = '';

UPDATE core.forums
SET slug = 'forum-' || id
WHERE slug = '';

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (PARTITION BY parent_id ORDER BY id) - 1 AS position
  FROM core.forums
)
UPDATE core.forums AS forum
SET position = ranked.position
FROM ranked
WHERE forum.id = ranked.id;

-- ---------------------------------------------------------------------------------------------
-- Path maintenance (moves, cycle rejection)
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION core.forums_assign_path()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = core, public, pg_temp
AS $$
DECLARE
  parent_path ltree;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN
    NEW.path := OLD.path;
    RETURN NEW;
  END IF;

  IF NEW.parent_id IS NULL THEN
    NEW.path := NEW.id::text::ltree;
  ELSE
    SELECT path INTO parent_path FROM core.forums WHERE id = NEW.parent_id;

    IF parent_path IS NULL THEN
      RAISE EXCEPTION 'forum % does not have a parent %', NEW.id, NEW.parent_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- The new parent is inside the old subtree, so the move would make a cycle.
    IF TG_OP = 'UPDATE' AND parent_path <@ OLD.path THEN
      RAISE EXCEPTION 'cannot move forum % under its own descendant %', NEW.id, NEW.parent_id
        USING ERRCODE = 'check_violation';
    END IF;

    NEW.path := parent_path || NEW.id::text::ltree;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION core.forums_assign_path() FROM PUBLIC;

DROP TRIGGER IF EXISTS forums_assign_path ON core.forums;

CREATE TRIGGER forums_assign_path
BEFORE INSERT OR UPDATE OF parent_id ON core.forums
FOR EACH ROW EXECUTE FUNCTION core.forums_assign_path();

CREATE OR REPLACE FUNCTION core.forums_move_subtree()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = core, public, pg_temp
AS $$
BEGIN
  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    UPDATE core.forums
    SET path = NEW.path || subpath(path, nlevel(OLD.path))
    WHERE path <@ OLD.path AND id <> NEW.id;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION core.forums_move_subtree() FROM PUBLIC;

DROP TRIGGER IF EXISTS forums_move_subtree ON core.forums;

CREATE TRIGGER forums_move_subtree
AFTER UPDATE OF parent_id ON core.forums
FOR EACH ROW EXECUTE FUNCTION core.forums_move_subtree();

-- Backfill after the trigger exists so any row inserted while migrating is also covered.
WITH RECURSIVE tree AS (
  SELECT id, id::text::ltree AS path
  FROM core.forums
  WHERE parent_id IS NULL

  UNION ALL

  SELECT child.id, tree.path || child.id::text::ltree
  FROM core.forums child
  JOIN tree ON child.parent_id = tree.id
)
UPDATE core.forums AS forum
SET path = tree.path
FROM tree
WHERE forum.id = tree.id;

ALTER TABLE core.forums ALTER COLUMN path SET NOT NULL;

CREATE OR REPLACE FUNCTION core.forums_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = core, public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION core.forums_touch() FROM PUBLIC;

DROP TRIGGER IF EXISTS forums_touch ON core.forums;

CREATE TRIGGER forums_touch
BEFORE UPDATE ON core.forums
FOR EACH ROW EXECUTE FUNCTION core.forums_touch();

CREATE INDEX IF NOT EXISTS forums_path_gist_idx ON core.forums USING gist (path);
CREATE INDEX IF NOT EXISTS forums_position_idx ON core.forums (parent_id, position, id);

-- ---------------------------------------------------------------------------------------------
-- Slug history: old forum slugs keep redirecting after a rename (ADR 0001)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.slug_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('forum', 'topic', 'profile')),
  resource_id bigint NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS slug_history_resource_idx
  ON core.slug_history (kind, resource_id, created_at DESC);

CREATE OR REPLACE FUNCTION core.forums_record_slug_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = core, public, pg_temp
AS $$
BEGIN
  IF OLD.slug <> '' AND OLD.slug IS DISTINCT FROM NEW.slug THEN
    INSERT INTO core.slug_history (kind, resource_id, slug)
    VALUES ('forum', OLD.id, OLD.slug);
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION core.forums_record_slug_history() FROM PUBLIC;

DROP TRIGGER IF EXISTS forums_record_slug_history ON core.forums;

CREATE TRIGGER forums_record_slug_history
AFTER UPDATE OF slug ON core.forums
FOR EACH ROW EXECUTE FUNCTION core.forums_record_slug_history();

-- ---------------------------------------------------------------------------------------------
-- Topic prefixes: labels per locale, optional group restriction, per-forum enablement
-- ---------------------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS core.prefixes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  colour text NOT NULL DEFAULT '#6b7280' CHECK (colour ~ '^#[0-9a-fA-F]{6}$'),
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.prefix_labels (
  prefix_id bigint NOT NULL REFERENCES core.prefixes (id) ON DELETE CASCADE,
  locale text NOT NULL CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  label text NOT NULL CHECK (char_length(btrim(label)) > 0),
  PRIMARY KEY (prefix_id, locale)
);

-- No row means the prefix is offered to every group; rows restrict it to those groups.
CREATE TABLE IF NOT EXISTS core.prefix_groups (
  prefix_id bigint NOT NULL REFERENCES core.prefixes (id) ON DELETE CASCADE,
  group_id bigint NOT NULL REFERENCES core.groups (id) ON DELETE CASCADE,
  PRIMARY KEY (prefix_id, group_id)
);

CREATE INDEX IF NOT EXISTS prefix_groups_group_idx ON core.prefix_groups (group_id);

CREATE TABLE IF NOT EXISTS core.forum_prefixes (
  forum_id bigint NOT NULL REFERENCES core.forums (id) ON DELETE CASCADE,
  prefix_id bigint NOT NULL REFERENCES core.prefixes (id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (forum_id, prefix_id)
);

CREATE INDEX IF NOT EXISTS forum_prefixes_prefix_idx ON core.forum_prefixes (prefix_id);

RESET ROLE;

GRANT SELECT ON core.slug_history, core.prefixes, core.prefix_labels, core.prefix_groups,
  core.forum_prefixes TO user_app, user_api, staff_api, workers;

GRANT INSERT, UPDATE, DELETE ON core.slug_history TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.slug_history_id_seq TO staff_api;

GRANT INSERT, UPDATE, DELETE ON core.prefixes, core.prefix_labels, core.prefix_groups,
  core.forum_prefixes TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.prefixes_id_seq TO staff_api;
