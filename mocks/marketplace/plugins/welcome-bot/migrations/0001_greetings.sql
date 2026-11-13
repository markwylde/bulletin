-- The welcome bot keeps one greeting per member, in its own schema.
CREATE TABLE IF NOT EXISTS greetings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL,
  greeting text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS greetings_member_idx ON greetings (member_id);
