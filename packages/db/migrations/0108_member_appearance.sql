-- 0108: member appearance preferences (ADR 0006, 0008; task 4.2).
-- Theme and colour-scheme choice are personal content: members read them through user_app,
-- user-api writes them, and the row disappears with the member (ADR 0012).

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.member_prefs
  ADD COLUMN IF NOT EXISTS theme_id bigint REFERENCES core.themes (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS colour_scheme text NOT NULL DEFAULT 'system'
    CHECK (colour_scheme IN ('light', 'dark', 'system'));

RESET ROLE;

GRANT SELECT ON core.member_prefs TO user_app, user_api, workers;
GRANT INSERT, UPDATE ON core.member_prefs TO user_api;
