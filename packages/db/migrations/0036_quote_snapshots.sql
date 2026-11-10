-- 0036: quote snapshots (ADR 0006, 0007, 0012).
--
-- A snapshot freezes the quoted source's markdown and rendered HTML so later edits do not
-- rewrite history. `source_kind` distinguishes forum posts from conversation messages; the
-- pipeline enforces that forum content only quotes posts and conversations only quote
-- messages from the same conversation. The source tables arrive with later changes, so this
-- table intentionally has no foreign key to them yet.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.quote_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_kind text NOT NULL CHECK (source_kind IN ('post', 'message')),
  source_id bigint NOT NULL CHECK (source_id > 0),
  source_author_id bigint REFERENCES core.members (id) ON DELETE SET NULL,
  body_md text NOT NULL,
  body_html text NOT NULL,
  render_version integer NOT NULL CHECK (render_version > 0),
  sanitiser_version integer NOT NULL CHECK (sanitiser_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  redacted_at timestamptz
);

-- Redacting a source post finds every snapshot of it in one index scan.
CREATE INDEX IF NOT EXISTS quote_snapshots_source_idx
  ON core.quote_snapshots (source_kind, source_id);

CREATE INDEX IF NOT EXISTS quote_snapshots_stale_idx
  ON core.quote_snapshots (render_version, sanitiser_version, id);

CREATE INDEX IF NOT EXISTS quote_snapshots_source_author_idx
  ON core.quote_snapshots (source_author_id)
  WHERE source_author_id IS NOT NULL;

RESET ROLE;

GRANT SELECT ON core.quote_snapshots TO user_app, staff_api, workers;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.quote_snapshots TO user_api, staff_api, workers;
GRANT USAGE, SELECT ON SEQUENCE core.quote_snapshots_id_seq TO user_api, staff_api, workers;
