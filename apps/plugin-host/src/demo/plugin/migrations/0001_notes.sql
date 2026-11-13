-- Demo migration for the sandbox. Runs as plugin_<id>_owner with search_path set to
-- the plugin schema, so unqualified names stay inside the plugin's own schema.
CREATE TABLE IF NOT EXISTS notes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION note_count() RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT count(*) FROM notes
$$;
