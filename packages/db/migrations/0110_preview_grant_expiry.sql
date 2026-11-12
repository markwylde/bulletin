-- 0110: theme preview grants expire with the signed token (10 minutes).

SET LOCAL ROLE bulletin_owner;

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

  DELETE FROM core.session_grants
  WHERE session_id = p_session_id AND kind = 'preview_theme_id';

  INSERT INTO core.session_grants (session_id, kind, resource_id, granted_at, expires_at)
  VALUES (p_session_id, 'preview_theme_id', p_theme_id, now(), now() + interval '10 minutes');

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION core.grant_preview_theme(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.grant_preview_theme(bigint, bigint)
  TO user_app, user_api, staff_api, workers;

-- Drop the older non-expiring preview grants; they were never intended to outlive the token.
DELETE FROM core.session_grants
WHERE kind = 'preview_theme_id' AND (expires_at IS NULL OR expires_at < now());

RESET ROLE;
