-- 0109: theme activation and a single preview selection per session (task 6 review).
--
-- New themes start inactive: they can be previewed by staff but are never offered to members
-- or guests until an admin activates them. The default and seeded demo themes are active.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.themes
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false;

UPDATE core.themes
SET is_active = true
WHERE name IN ('default', 'sunset', 'vip-gold');

CREATE OR REPLACE FUNCTION core.grant_preview_theme(p_session_id bigint, p_theme_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.sessions WHERE id = p_session_id) THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM core.themes WHERE id = p_theme_id) THEN
    RETURN false;
  END IF;

  -- One preview at a time: previewing B replaces A instead of leaving both grants.
  DELETE FROM core.session_grants
  WHERE session_id = p_session_id AND kind = 'preview_theme_id';

  INSERT INTO core.session_grants (session_id, kind, resource_id, granted_at)
  VALUES (p_session_id, 'preview_theme_id', p_theme_id, now());

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION core.grant_preview_theme(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.grant_preview_theme(bigint, bigint)
  TO user_app, user_api, staff_api, workers;

RESET ROLE;
