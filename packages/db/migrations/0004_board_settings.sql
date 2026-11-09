-- 0004: the single board settings row seeded by the base module.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.board_settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  board_name text NOT NULL,
  board_description text NOT NULL DEFAULT ''
);

RESET ROLE;

GRANT SELECT ON core.board_settings TO user_app, user_api, workers;
GRANT SELECT, UPDATE ON core.board_settings TO staff_api;
