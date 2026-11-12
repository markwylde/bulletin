-- 0103: full-text search indexes for topics, posts and member names (ADR 0017).
--
-- `lang` is stored per row and drives a generated `tsv`, so new and edited content is
-- searchable in the same statement that writes it (no indexing lag). `tsv_simple` keeps the
-- unstemmed words as a second index path for mixed-language content. `simple` is the fallback
-- when a forum has no language.
--
-- Forum language changes are rebuilt in batches by the worker; the forum row records the
-- language version and the version the index has caught up with (ADR 0003, 0011).

-- The trigram index for member names needs the extension; create it as the connection role
-- (bulletin_owner does not have CREATE on the database, same as `ltree` in 0031).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

SET LOCAL ROLE bulletin_owner;

-- The locale-to-config mapping is shared by writes, the rebuild job and later queries.
CREATE OR REPLACE FUNCTION core.search_config(locale text)
RETURNS regconfig
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE lower(split_part(coalesce(locale, ''), '-', 1))
    WHEN 'en' THEN 'english'::regconfig
    WHEN 'es' THEN 'spanish'::regconfig
    WHEN 'fr' THEN 'french'::regconfig
    ELSE 'simple'::regconfig
  END
$$;

REVOKE ALL ON FUNCTION core.search_config(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.search_config(text)
  TO user_app, user_api, staff_api, workers;

-- ---------------------------------------------------------------------------------------------
-- Topics
-- ---------------------------------------------------------------------------------------------

ALTER TABLE core.topics
  ADD COLUMN IF NOT EXISTS lang regconfig NOT NULL DEFAULT 'simple';

UPDATE core.topics AS topic
SET lang = core.search_config(forum.language)
FROM core.forums AS forum
WHERE forum.id = topic.forum_id
  AND topic.lang IS DISTINCT FROM core.search_config(forum.language);

ALTER TABLE core.topics
  ADD COLUMN IF NOT EXISTS tsv tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector(lang, coalesce(title, '')), 'A')
    ) STORED;

ALTER TABLE core.topics
  ADD COLUMN IF NOT EXISTS tsv_simple tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(title, '')), 'A')
    ) STORED;

CREATE INDEX IF NOT EXISTS topics_search_idx
  ON core.topics USING gin (tsv);

CREATE INDEX IF NOT EXISTS topics_search_simple_idx
  ON core.topics USING gin (tsv_simple);

-- Guests and ordinary members only ever see visible topics; moderators use the full index.
CREATE INDEX IF NOT EXISTS topics_search_visible_idx
  ON core.topics USING gin (tsv)
  WHERE visibility = 'visible';

CREATE INDEX IF NOT EXISTS topics_search_simple_visible_idx
  ON core.topics USING gin (tsv_simple)
  WHERE visibility = 'visible';

-- ---------------------------------------------------------------------------------------------
-- Posts
-- ---------------------------------------------------------------------------------------------

ALTER TABLE core.posts
  ADD COLUMN IF NOT EXISTS lang regconfig NOT NULL DEFAULT 'simple';

UPDATE core.posts AS post
SET lang = core.search_config(forum.language)
FROM core.topics AS topic
JOIN core.forums AS forum ON forum.id = topic.forum_id
WHERE topic.id = post.topic_id
  AND post.lang IS DISTINCT FROM core.search_config(forum.language);

ALTER TABLE core.posts
  ADD COLUMN IF NOT EXISTS tsv tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector(lang, coalesce(body_text, '')), 'B')
    ) STORED;

ALTER TABLE core.posts
  ADD COLUMN IF NOT EXISTS tsv_simple tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', coalesce(body_text, '')), 'B')
    ) STORED;

CREATE INDEX IF NOT EXISTS posts_search_idx
  ON core.posts USING gin (tsv);

CREATE INDEX IF NOT EXISTS posts_search_simple_idx
  ON core.posts USING gin (tsv_simple);

CREATE INDEX IF NOT EXISTS posts_search_visible_idx
  ON core.posts USING gin (tsv)
  WHERE visibility = 'visible';

CREATE INDEX IF NOT EXISTS posts_search_simple_visible_idx
  ON core.posts USING gin (tsv_simple)
  WHERE visibility = 'visible';

-- ---------------------------------------------------------------------------------------------
-- Member name search (trigram, case-insensitive)
-- ---------------------------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS members_display_name_trgm_idx
  ON core.members USING gin (lower(display_name) gin_trgm_ops)
  WHERE display_name IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Forum language rebuild bookkeeping
-- ---------------------------------------------------------------------------------------------

ALTER TABLE core.forums
  ADD COLUMN IF NOT EXISTS search_lang_version bigint NOT NULL DEFAULT 0;

ALTER TABLE core.forums
  ADD COLUMN IF NOT EXISTS search_lang_indexed_version bigint NOT NULL DEFAULT 0;

ALTER TABLE core.forums DROP CONSTRAINT IF EXISTS forums_search_lang_version_check;
ALTER TABLE core.forums
  ADD CONSTRAINT forums_search_lang_version_check
  CHECK (search_lang_indexed_version <= search_lang_version);

RESET ROLE;

-- The rebuild worker owns only the `lang` columns and the catch-up version.
GRANT UPDATE (lang) ON core.topics, core.posts TO workers;
GRANT UPDATE (search_lang_indexed_version) ON core.forums TO workers;
