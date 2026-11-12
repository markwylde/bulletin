-- 0097: recheck the moderator's view-IP power when a post-IP grant is redeemed
-- (moderation review finding; ADR 0004, 0006, 0012).
--
-- A grant opened while the moderator could view IPs must not survive losing that power or the
-- post moving outside the moderated forum. Redemption now checks the post's current forum.

SET LOCAL ROLE pii_owner;

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
  v_forum_id bigint;
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

  -- The moderator's power is evaluated against the post's current forum, so revoking it or
  -- moving the post out of scope makes the outstanding grant unusable.
  IF NOT core.has_mod_power(v_grant.actor_member_id, v_forum_id, 'view_ips') THEN
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

RESET ROLE;
