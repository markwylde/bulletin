-- 0010: the session list's own-data read (ADR 0012).
-- The actor is derived from the raw session token; callers never pass a member ID.

SET LOCAL ROLE pii_owner;

CREATE OR REPLACE FUNCTION pii.browser_family(p_user_agent text) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pii, pg_temp
AS $$
  SELECT CASE
    WHEN nullif(btrim(p_user_agent), '') IS NULL THEN 'unknown'
    WHEN p_user_agent ~* 'Edg/|EdgA/|EdgiOS/' THEN 'edge'
    WHEN p_user_agent ~* 'OPR/' THEN 'opera'
    WHEN p_user_agent ~* 'SamsungBrowser/' THEN 'samsung'
    WHEN p_user_agent ~* 'Firefox/|FxiOS/' THEN 'firefox'
    WHEN p_user_agent ~* 'Chrome/|CriOS/' THEN 'chrome'
    WHEN p_user_agent ~* 'Safari/' THEN 'safari'
    ELSE 'other'
  END;
$$;

CREATE OR REPLACE FUNCTION pii.list_own_sessions(p_session_token text)
RETURNS TABLE (
  session_id bigint,
  kind text,
  is_current boolean,
  created_at timestamptz,
  last_seen_at timestamptz,
  ip text,
  browser_family text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_session_id bigint;
  v_member_id bigint;
BEGIN
  IF p_session_token IS NULL OR p_session_token = '' THEN
    RETURN;
  END IF;

  -- ADR 0018 lifetimes: user 30 days idle / 90 days absolute, staff 2 hours / 12 hours.
  SELECT s.id, s.member_id
    INTO v_session_id, v_member_id
    FROM core.sessions s
   WHERE s.token_hash = sha256(convert_to(p_session_token, 'UTF8'))
     AND s.revoked_at IS NULL
     AND s.last_seen_at > now() - CASE
           WHEN s.kind = 'staff' THEN interval '2 hours'
           ELSE interval '30 days'
         END
     AND s.created_at > now() - CASE
           WHEN s.kind = 'staff' THEN interval '12 hours'
           ELSE interval '90 days'
         END;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO pii.access_log (actor_member_id, subject_member_id, purpose, resource_type)
  VALUES (v_member_id, v_member_id, 'own_data', 'session');

  RETURN QUERY
    SELECT s.id,
           s.kind,
           s.id = v_session_id,
           s.created_at,
           s.last_seen_at,
           host(m.ip),
           pii.browser_family(m.user_agent)
      FROM core.sessions s
      LEFT JOIN pii.session_meta m ON m.session_id = s.id
     WHERE s.member_id = v_member_id
       AND s.revoked_at IS NULL
       AND s.last_seen_at > now() - CASE
             WHEN s.kind = 'staff' THEN interval '2 hours'
             ELSE interval '30 days'
           END
       AND s.created_at > now() - CASE
             WHEN s.kind = 'staff' THEN interval '12 hours'
             ELSE interval '90 days'
           END
     ORDER BY (s.id = v_session_id) DESC, s.last_seen_at DESC, s.id DESC;
END;
$$;

REVOKE ALL ON FUNCTION pii.browser_family(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.list_own_sessions(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION pii.list_own_sessions(text) TO user_api, staff_api;

RESET ROLE;
