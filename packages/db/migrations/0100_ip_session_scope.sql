-- 0100: audited IP access honours the staff session's password-forum unlocks
-- (moderation review fix; ADR 0005, 0012, 0018).
--
-- `core.has_mod_power` is the member-level mirror. Every checked IP path acts for a live
-- session, so it must use `core.has_mod_power_for_session`; otherwise staff who moderate a
-- password forum can read its IP records without unlocking it in this session.

SET LOCAL ROLE pii_owner;

-- One session lookup shared by every audited IP action. The caller needs both the session row
-- (for the unlock grants) and the member (for the power itself).
CREATE OR REPLACE FUNCTION pii.session_for_token(p_session_token text)
RETURNS TABLE (session_id bigint, actor_member_id bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
  SELECT s.id, s.member_id
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

CREATE OR REPLACE FUNCTION pii.session_member(p_session_token text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
  SELECT actor_member_id FROM pii.session_for_token(p_session_token)
$$;

CREATE OR REPLACE FUNCTION pii.open_access(
  p_session_token text,
  p_purpose text,
  p_resource_type text,
  p_resource_id bigint
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_session_id bigint;
  v_member_id bigint;
  v_forum_id bigint;
  v_subject bigint;
  v_grant_id bigint;
BEGIN
  IF p_session_token IS NULL OR p_session_token = '' OR p_purpose NOT IN ('post_ip', 'reverse_ip', 'login_ips') THEN
    RETURN NULL;
  END IF;

  SELECT session_id, actor_member_id
    INTO v_session_id, v_member_id
    FROM pii.session_for_token(p_session_token);

  IF v_member_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_purpose IN ('post_ip', 'reverse_ip') THEN
    IF p_resource_type <> 'post' THEN
      RETURN NULL;
    END IF;

    SELECT t.forum_id, p.author_id
      INTO v_forum_id, v_subject
      FROM core.posts p JOIN core.topics t ON t.id = p.topic_id
     WHERE p.id = p_resource_id;

    IF NOT FOUND
       OR NOT core.has_mod_power_for_session(v_member_id, v_forum_id, 'view_ips', v_session_id)
    THEN
      RETURN NULL;
    END IF;
  ELSE
    IF p_resource_type <> 'member' THEN
      RETURN NULL;
    END IF;

    IF NOT core.has_acp(v_member_id, 'members.view_ips') THEN
      RETURN NULL;
    END IF;

    SELECT id INTO v_subject FROM core.members WHERE id = p_resource_id;

    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  )
  VALUES (v_member_id, v_subject, p_purpose, p_resource_type, p_resource_id::text);

  INSERT INTO pii.access_grants (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id,
    xact_id, expires_at
  )
  VALUES (
    v_member_id, v_subject, p_purpose, p_resource_type, p_resource_id,
    pg_current_xact_id(), now() + interval '60 seconds'
  )
  RETURNING id INTO v_grant_id;

  RETURN v_grant_id;
END;
$$;

CREATE OR REPLACE FUNCTION pii.read_post_ip(p_session_token text, p_grant_id bigint)
RETURNS TABLE (ip text, expired boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_session_id bigint;
  v_actor bigint;
  v_grant pii.access_grants%ROWTYPE;
  v_retention integer;
  v_created timestamptz;
  v_forum_id bigint;
  v_ip inet;
BEGIN
  SELECT session_id, actor_member_id
    INTO v_session_id, v_actor
    FROM pii.session_for_token(p_session_token);

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

  SELECT p.created_at, t.forum_id
    INTO v_created, v_forum_id
    FROM core.posts p
    JOIN core.topics t ON t.id = p.topic_id
   WHERE p.id = v_grant.resource_id;

  IF NOT FOUND THEN
    UPDATE pii.access_grants SET consumed_at = now() WHERE id = p_grant_id;
    RETURN QUERY SELECT NULL::text, true;
    RETURN;
  END IF;

  -- The moderator's power is evaluated against the post's current forum and this session, so
  -- revoking it, moving the post out of scope or a lapsed password unlock makes an outstanding
  -- grant unusable.
  IF NOT core.has_mod_power_for_session(v_actor, v_forum_id, 'view_ips', v_session_id) THEN
    RETURN;
  END IF;

  UPDATE pii.access_grants SET consumed_at = now() WHERE id = p_grant_id;
  SELECT ip_retention_days INTO v_retention FROM core.board_settings WHERE id = 1;

  SELECT pi.ip INTO v_ip FROM pii.post_ips pi WHERE pi.post_id = v_grant.resource_id;

  IF v_ip IS NULL OR v_created < now() - make_interval(days => v_retention) THEN
    RETURN QUERY SELECT NULL::text, true;
    RETURN;
  END IF;

  RETURN QUERY SELECT host(v_ip), false;
END;
$$;

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
  v_session_id bigint;
  v_actor bigint;
  v_grant pii.access_grants%ROWTYPE;
  v_ip inet;
  v_retention integer;
BEGIN
  SELECT session_id, actor_member_id
    INTO v_session_id, v_actor
    FROM pii.session_for_token(p_session_token);

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
       AND core.has_mod_power_for_session(v_actor, t.forum_id, 'view_ips', v_session_id)
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT 100;
END;
$$;

CREATE OR REPLACE FUNCTION pii.read_login_ips(p_session_token text, p_grant_id bigint)
RETURNS TABLE (ip text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_session_id bigint;
  v_actor bigint;
  v_grant pii.access_grants%ROWTYPE;
  v_retention integer;
BEGIN
  SELECT session_id, actor_member_id
    INTO v_session_id, v_actor
    FROM pii.session_for_token(p_session_token);

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

  IF NOT core.has_acp(v_actor, 'members.view_ips') THEN
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

REVOKE ALL ON FUNCTION pii.session_for_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.session_member(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.open_access(text, text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.read_post_ip(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.read_members_by_ip(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.read_login_ips(text, bigint) FROM PUBLIC;

RESET ROLE;

GRANT EXECUTE ON FUNCTION pii.open_access(text, text, text, bigint) TO staff_api;
GRANT EXECUTE ON FUNCTION pii.read_post_ip(text, bigint) TO staff_api;
GRANT EXECUTE ON FUNCTION pii.read_members_by_ip(text, bigint) TO staff_api;
GRANT EXECUTE ON FUNCTION pii.read_login_ips(text, bigint) TO staff_api;
