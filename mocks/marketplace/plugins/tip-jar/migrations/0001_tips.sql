-- One tip per post/member, in the plugin's own schema.
CREATE TABLE IF NOT EXISTS tips (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id bigint NOT NULL,
  member_id bigint NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
