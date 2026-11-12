-- 0101: reverse-IP lookups revalidate the source post before using its IP
-- (moderation review fix; ADR 0005, 0012, 0018).
--
-- Filtering the returned correlation rows is not enough: the source post's IP is the key, so
-- it must itself still be inside the actor's view-IP power, in this session's unlocked forums,
-- and inside the retention window. Otherwise a grant outlives its source: a revoked power, a
-- post moved to an unmoderated forum, a lapsed password unlock or an aged-out post keeps
-- leaking "who else used this address". The returned rows are revalidated the same way.

SET LOCAL ROLE pii_owner;

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
  v_created timestamptz;
  v_forum_id bigint;
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

  SELECT ip_retention_days INTO v_retention FROM core.board_settings WHERE id = 1;

  -- Revalidate the source: its current forum, this session's unlock and retention all have to
  -- hold now, not only when the grant was opened.
  SELECT pi.ip, p.created_at, t.forum_id
    INTO v_ip, v_created, v_forum_id
    FROM pii.post_ips pi
    JOIN core.posts p ON p.id = pi.post_id
    JOIN core.topics t ON t.id = p.topic_id
   WHERE pi.post_id = v_grant.resource_id;

  IF NOT FOUND OR v_created < now() - make_interval(days => v_retention) THEN
    UPDATE pii.access_grants SET consumed_at = now() WHERE id = p_grant_id;
    RETURN;
  END IF;

  IF NOT core.has_mod_power_for_session(v_actor, v_forum_id, 'view_ips', v_session_id) THEN
    RETURN;
  END IF;

  UPDATE pii.access_grants SET consumed_at = now() WHERE id = p_grant_id;

  -- Every returned row is revalidated too: its post's current forum, this session's unlock and
  -- its own retention cutoff.
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

REVOKE ALL ON FUNCTION pii.read_members_by_ip(text, bigint) FROM PUBLIC;

RESET ROLE;

GRANT EXECUTE ON FUNCTION pii.read_members_by_ip(text, bigint) TO staff_api;
