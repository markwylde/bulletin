-- 0070: resumable reputation recount runs with staff-visible progress (design risk).
--
-- A board recount rebuilds reaction entries once, then recomputes member totals in id-ordered
-- batches. The row keeps the cursor and progress so a retried job resumes instead of restarting
-- and the staff app can show how far it has got. Only one run is active at a time.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.reputation_recounts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done')),
  reason text NOT NULL DEFAULT 'manual',
  total_members integer NOT NULL DEFAULT 0 CHECK (total_members >= 0),
  processed_members integer NOT NULL DEFAULT 0 CHECK (processed_members >= 0),
  changed_members integer NOT NULL DEFAULT 0 CHECK (changed_members >= 0),
  cursor_member_id bigint NOT NULL DEFAULT 0,
  rebuilt_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS reputation_recounts_running_key
  ON core.reputation_recounts (status)
  WHERE status = 'running';

RESET ROLE;

GRANT SELECT ON core.reputation_recounts TO staff_api, user_app;
GRANT SELECT, INSERT, UPDATE ON core.reputation_recounts TO workers;
GRANT USAGE, SELECT ON SEQUENCE core.reputation_recounts_id_seq TO workers;
