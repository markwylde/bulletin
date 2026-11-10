-- 0033: redirect-forum click buffer (ADR 0001, 0006).
-- A redirect click is a read-path write: user-app appends to this UNLOGGED table and a worker
-- folds the rows into `core.forums.redirect_clicks` every minute. Nothing bumps a content tag,
-- so a click never invalidates a cached page.

SET LOCAL ROLE bulletin_owner;

CREATE UNLOGGED TABLE IF NOT EXISTS core.forum_redirect_clicks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  forum_id bigint NOT NULL REFERENCES core.forums (id) ON DELETE CASCADE,
  clicked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS forum_redirect_clicks_forum_idx
  ON core.forum_redirect_clicks (forum_id, clicked_at);

RESET ROLE;

GRANT INSERT ON core.forum_redirect_clicks TO user_app;
GRANT USAGE, SELECT ON SEQUENCE core.forum_redirect_clicks_id_seq TO user_app;
GRANT SELECT, DELETE ON core.forum_redirect_clicks TO workers;
GRANT SELECT ON core.forum_redirect_clicks TO staff_api;

-- The worker folds buffered clicks into the denormalised counter; it never touches tags.
GRANT UPDATE (redirect_clicks) ON core.forums TO workers;
