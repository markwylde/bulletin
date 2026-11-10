-- 0039: forum rules and announcements render through the content pipeline (ADR 0007).
--
-- The existing text columns stay as the markdown source; the rendered HTML, plain text and
-- versions are derived at write time so reads never parse markdown.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.forums
  ADD COLUMN IF NOT EXISTS rules_html text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS rules_text text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS rules_render_version integer NOT NULL DEFAULT 1 CHECK (rules_render_version > 0),
  ADD COLUMN IF NOT EXISTS rules_sanitiser_version integer NOT NULL DEFAULT 1 CHECK (rules_sanitiser_version > 0);

ALTER TABLE core.announcements
  ADD COLUMN IF NOT EXISTS body_html text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS body_text text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS render_version integer NOT NULL DEFAULT 1 CHECK (render_version > 0),
  ADD COLUMN IF NOT EXISTS sanitiser_version integer NOT NULL DEFAULT 1 CHECK (sanitiser_version > 0);

RESET ROLE;
