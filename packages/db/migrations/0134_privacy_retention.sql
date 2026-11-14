-- 0134: configurable retention settings and the nightly purge (ADR 0012; privacy-gdpr 2.1).
--
-- `core.privacy_settings` is the single source of truth for retention. The old
-- `core.board_settings.ip_retention_days` column is migrated and then dropped; every IP
-- disclosure path reads the same setting, so an admin cannot configure two different windows.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.privacy_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ip_log_retention_days integer NOT NULL DEFAULT 90
    CHECK (ip_log_retention_days BETWEEN 1 AND 3_650),
  session_meta_retention_days integer NOT NULL DEFAULT 30
    CHECK (session_meta_retention_days BETWEEN 1 AND 3_650),
  revoked_session_retention_days integer NOT NULL DEFAULT 7
    CHECK (revoked_session_retention_days BETWEEN 1 AND 3_650),
  access_log_retention_days integer NOT NULL DEFAULT 730
    CHECK (access_log_retention_days BETWEEN 1 AND 3_650),
  export_retention_days integer NOT NULL DEFAULT 7
    CHECK (export_retention_days BETWEEN 1 AND 3_650),
  ip_ban_retention_days integer NOT NULL DEFAULT 365
    CHECK (ip_ban_retention_days BETWEEN 1 AND 3_650),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Keep the window an existing board configured before this change.
INSERT INTO core.privacy_settings (id, ip_log_retention_days)
SELECT 1, COALESCE(
  (SELECT ip_retention_days FROM core.board_settings WHERE id = 1),
  90
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO core.group_settings (group_id, key, value)
SELECT id, 'privacy.manage', to_jsonb(true)
FROM core.groups
WHERE key = 'administrators'
ON CONFLICT (group_id, key) DO NOTHING;

RESET ROLE;

GRANT SELECT ON core.privacy_settings TO staff_api, workers, pii_owner;
GRANT INSERT, UPDATE ON core.privacy_settings TO staff_api;

-- Retention removes expired IP bans. IP bans are not restricted data (ADR 0012).
GRANT DELETE ON core.ip_bans TO workers;

SET LOCAL ROLE pii_owner;

ALTER TABLE pii.data_requests
  ADD COLUMN IF NOT EXISTS export_key text;
ALTER TABLE pii.data_requests
  ADD COLUMN IF NOT EXISTS export_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS data_requests_export_expiry_idx
  ON pii.data_requests (export_expires_at)
  WHERE export_key IS NOT NULL;

COMMENT ON COLUMN pii.data_requests.export_key
  IS '@personal class=personal-content';
COMMENT ON COLUMN pii.data_requests.export_expires_at
  IS '@personal class=personal-content';

-- One shared window for every audited IP read.
CREATE OR REPLACE FUNCTION pii.ip_retention_days()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT ip_log_retention_days FROM core.privacy_settings WHERE id = 1),
    90
  )
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
  v_retention := pii.ip_retention_days();

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

  v_retention := pii.ip_retention_days();

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
  v_retention := pii.ip_retention_days();

  RETURN QUERY
    SELECT host(l.ip), l.created_at
      FROM pii.ip_log l
     WHERE l.member_id = v_grant.resource_id
       AND l.created_at >= now() - make_interval(days => v_retention)
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT 100;
END;
$$;

DROP FUNCTION IF EXISTS pii.purge_expired();

CREATE OR REPLACE FUNCTION pii.purge_expired(p_now timestamptz DEFAULT now())
RETURNS TABLE (
  post_ips bigint,
  login_ips bigint,
  access_log bigint,
  session_meta bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_ip_days integer;
  v_meta_days integer;
  v_access_days integer;
  v_post_ips bigint;
  v_login_ips bigint;
  v_access bigint;
  v_meta bigint;
BEGIN
  SELECT coalesce(ip_log_retention_days, 90),
         coalesce(session_meta_retention_days, 30),
         coalesce(access_log_retention_days, 730)
    INTO v_ip_days, v_meta_days, v_access_days
    FROM core.privacy_settings
   WHERE id = 1;

  IF NOT FOUND THEN
    v_ip_days := 90;
    v_meta_days := 30;
    v_access_days := 730;
  END IF;

  DELETE FROM pii.post_ips
   WHERE created_at < p_now - make_interval(days => v_ip_days);
  GET DIAGNOSTICS v_post_ips = ROW_COUNT;

  DELETE FROM pii.ip_log
   WHERE created_at < p_now - make_interval(days => v_ip_days);
  GET DIAGNOSTICS v_login_ips = ROW_COUNT;

  DELETE FROM pii.access_log
   WHERE created_at < p_now - make_interval(days => v_access_days);
  GET DIAGNOSTICS v_access = ROW_COUNT;

  DELETE FROM pii.session_meta
   WHERE updated_at < p_now - make_interval(days => v_meta_days);
  GET DIAGNOSTICS v_meta = ROW_COUNT;

  RETURN QUERY SELECT v_post_ips, v_login_ips, v_access, v_meta;
END;
$$;

-- Export archives are objects, so the worker asks for the expired keys first, deletes the
-- object, then clears the metadata. A storage failure leaves the row for the next nightly run.
CREATE OR REPLACE FUNCTION pii.expired_exports(p_now timestamptz DEFAULT now())
RETURNS TABLE (request_id bigint, export_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_export_days integer;
BEGIN
  SELECT coalesce(export_retention_days, 7)
    INTO v_export_days
    FROM core.privacy_settings
   WHERE id = 1;

  IF NOT FOUND THEN
    v_export_days := 7;
  END IF;

  RETURN QUERY
    SELECT r.id, r.export_key
      FROM pii.data_requests r
     WHERE r.export_key IS NOT NULL
       AND (
         (r.export_expires_at IS NOT NULL AND r.export_expires_at <= p_now)
         OR r.created_at < p_now - make_interval(days => v_export_days)
       )
     ORDER BY r.id;
END;
$$;

CREATE OR REPLACE FUNCTION pii.clear_expired_export(
  p_request_id bigint,
  p_now timestamptz DEFAULT now()
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_export_days integer;
BEGIN
  SELECT coalesce(export_retention_days, 7)
    INTO v_export_days
    FROM core.privacy_settings
   WHERE id = 1;

  IF NOT FOUND THEN
    v_export_days := 7;
  END IF;

  UPDATE pii.data_requests r
     SET export_key = NULL,
         export_expires_at = NULL,
         updated_at = p_now
   WHERE r.id = p_request_id
     AND r.export_key IS NOT NULL
     AND (
       (r.export_expires_at IS NOT NULL AND r.export_expires_at <= p_now)
       OR r.created_at < p_now - make_interval(days => v_export_days)
     );

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION pii.ip_retention_days() FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.purge_expired(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.expired_exports(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.clear_expired_export(bigint, timestamptz) FROM PUBLIC;

RESET ROLE;

GRANT EXECUTE ON FUNCTION pii.purge_expired(timestamptz) TO workers;
GRANT EXECUTE ON FUNCTION pii.expired_exports(timestamptz) TO workers;
GRANT EXECUTE ON FUNCTION pii.clear_expired_export(bigint, timestamptz) TO workers;

-- The window now lives in privacy_settings; keeping the old column would let two screens
-- disagree about how long an IP may be disclosed.
ALTER TABLE core.board_settings DROP COLUMN IF EXISTS ip_retention_days;
