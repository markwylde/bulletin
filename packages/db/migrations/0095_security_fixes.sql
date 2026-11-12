-- 0095: bind IP grant redemption to the staff session and let workers expire bans
-- (moderation review fixes; ADR 0012, 0018).

SET LOCAL ROLE pii_owner;

-- One session lookup shared by every audited IP read. A grant is only redeemable by the
-- authenticated staff member who opened it, not by anyone who guesses its sequential id.
CREATE OR REPLACE FUNCTION pii.session_member(p_session_token text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
  SELECT s.member_id
    FROM core.sessions s
   WHERE p_session_token IS NOT NULL
     AND p_session_token <> ''
     AND s.token_hash = sha256(convert_to(p_session_token, 'UTF8'))
     AND s.kind = 'staff'
     AND s.revoked_at IS NULL
     AND s.last_seen_at > now() - interval '2 hours'
     AND s.created_at > now() - interval '12 hours'
     AND s.last_auth_at > now() - interval '15 minutes'
   LIMIT 1
$$;

DROP FUNCTION IF EXISTS pii.read_post_ip(bigint);

CREATE OR REPLACE FUNCTION pii.read_post_ip(p_session_token text, p_grant_id bigint)
RETURNS TABLE (ip text, expired boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_actor bigint;
  v_grant pii.access_grants%ROWTYPE;
  v_retention integer;
  v_created timestamptz;
  v_ip inet;
BEGIN
  v_actor := pii.session_member(p_session_token);

  IF v_actor IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_grant FROM pii.access_grants
   WHERE id = p_grant_id
     AND actor_member_id = v_actor
     AND purpose = 'post_ip'
     AND resource_type = 'post'
     AND consumed_at IS NULL
     AND expires_at > now()
   FOR UPDATE;

  IF NOT FOUND OR pg_xact_status(v_grant.xact_id) <> 'committed' THEN
    RETURN;
  END IF;

  UPDATE pii.access_grants SET consumed_at = now() WHERE id = p_grant_id;

  SELECT p.created_at INTO v_created FROM core.posts p WHERE p.id = v_grant.resource_id;
  SELECT ip_retention_days INTO v_retention FROM core.board_settings WHERE id = 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, true;
    RETURN;
  END IF;

  SELECT pi.ip INTO v_ip FROM pii.post_ips pi WHERE pi.post_id = v_grant.resource_id;

  IF v_ip IS NULL OR v_created < now() - make_interval(days => v_retention) THEN
    RETURN QUERY SELECT NULL::text, true;
    RETURN;
  END IF;

  RETURN QUERY SELECT host(v_ip), false;
END;
$$;

DROP FUNCTION IF EXISTS pii.read_members_by_ip(bigint);

CREATE OR REPLACE FUNCTION pii.read_members_by_ip(p_session_token text, p_grant_id bigint)
RETURNS TABLE (
  member_id bigint,
  display_name text,
  post_id bigint,
  forum_id bigint,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_actor bigint;
  v_grant pii.access_grants%ROWTYPE;
  v_ip inet;
  v_retention integer;
BEGIN
  v_actor := pii.session_member(p_session_token);

  IF v_actor IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_grant FROM pii.access_grants
   WHERE id = p_grant_id
     AND actor_member_id = v_actor
     AND purpose = 'reverse_ip'
     AND resource_type = 'post'
     AND consumed_at IS NULL
     AND expires_at > now()
   FOR UPDATE;

  IF NOT FOUND OR pg_xact_status(v_grant.xact_id) <> 'committed' THEN
    RETURN;
  END IF;

  UPDATE pii.access_grants SET consumed_at = now() WHERE id = p_grant_id;

  SELECT pi.ip INTO v_ip
    FROM pii.post_ips pi
    JOIN core.posts p ON p.id = pi.post_id
   WHERE pi.post_id = v_grant.resource_id;
  SELECT ip_retention_days INTO v_retention FROM core.board_settings WHERE id = 1;

  IF v_ip IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT DISTINCT m.id, m.display_name, p.id, t.forum_id, p.created_at
      FROM pii.post_ips pi
      JOIN core.posts p ON p.id = pi.post_id
      JOIN core.topics t ON t.id = p.topic_id
      JOIN core.members m ON m.id = p.author_id
     WHERE pi.ip = v_ip
       AND p.created_at >= now() - make_interval(days => v_retention)
       AND core.has_mod_power(v_grant.actor_member_id, t.forum_id, 'view_ips')
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT 100;
END;
$$;

DROP FUNCTION IF EXISTS pii.read_login_ips(bigint);

CREATE OR REPLACE FUNCTION pii.read_login_ips(p_session_token text, p_grant_id bigint)
RETURNS TABLE (ip text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_actor bigint;
  v_grant pii.access_grants%ROWTYPE;
  v_retention integer;
BEGIN
  v_actor := pii.session_member(p_session_token);

  IF v_actor IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO v_grant FROM pii.access_grants
   WHERE id = p_grant_id
     AND actor_member_id = v_actor
     AND purpose = 'login_ips'
     AND resource_type = 'member'
     AND consumed_at IS NULL
     AND expires_at > now()
   FOR UPDATE;

  IF NOT FOUND OR pg_xact_status(v_grant.xact_id) <> 'committed' THEN
    RETURN;
  END IF;

  IF NOT core.has_acp(v_grant.actor_member_id, 'members.view_ips') THEN
    RETURN;
  END IF;

  UPDATE pii.access_grants SET consumed_at = now() WHERE id = p_grant_id;
  SELECT ip_retention_days INTO v_retention FROM core.board_settings WHERE id = 1;

  RETURN QUERY
    SELECT host(l.ip), l.created_at
      FROM pii.ip_log l
     WHERE l.member_id = v_grant.resource_id
       AND l.created_at >= now() - make_interval(days => v_retention)
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION pii.session_member(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.read_post_ip(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.read_members_by_ip(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.read_login_ips(text, bigint) FROM PUBLIC;

RESET ROLE;

GRANT EXECUTE ON FUNCTION pii.read_post_ip(text, bigint) TO staff_api;
GRANT EXECUTE ON FUNCTION pii.read_members_by_ip(text, bigint) TO staff_api;
GRANT EXECUTE ON FUNCTION pii.read_login_ips(text, bigint) TO staff_api;

-- Expiry restores group rows and then removes the ban; the worker role needs both.
GRANT DELETE ON core.member_bans TO workers;
