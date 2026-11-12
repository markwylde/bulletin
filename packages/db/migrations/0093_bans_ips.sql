-- 0093: member bans, IP/CIDR bans and audited IP lookups (moderation 6.1-6.5; ADR 0012, 0018).
--
-- IP bans live in core and are compared by the app; restricted IP records live in pii and are
-- only reachable through two-transaction audited definer functions.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.board_settings
  ADD COLUMN IF NOT EXISTS ip_retention_days integer NOT NULL DEFAULT 90;
ALTER TABLE core.board_settings DROP CONSTRAINT IF EXISTS board_ip_retention_days_check;
ALTER TABLE core.board_settings
  ADD CONSTRAINT board_ip_retention_days_check
  CHECK (ip_retention_days BETWEEN 1 AND 3_650);

CREATE TABLE IF NOT EXISTS core.ip_bans (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cidr inet NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  expires_at timestamptz,
  created_by bigint REFERENCES core.members (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ip_bans_cidr_key UNIQUE (cidr)
);

CREATE INDEX IF NOT EXISTS ip_bans_cidr_gist_idx ON core.ip_bans USING gist (cidr inet_ops);
CREATE INDEX IF NOT EXISTS ip_bans_expiry_idx ON core.ip_bans (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.member_bans (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  expires_at timestamptz,
  previous_groups jsonb NOT NULL,
  created_by bigint REFERENCES core.members (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS member_bans_member_key
  ON core.member_bans (member_id);
CREATE INDEX IF NOT EXISTS member_bans_expiry_idx ON core.member_bans (expires_at)
  WHERE expires_at IS NOT NULL;

-- Ban/IP management permissions.
INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, p.permission, to_jsonb(true)
FROM core.groups g
CROSS JOIN (
  VALUES ('members.ban'), ('bans.ip'), ('members.view_ips')
) AS p (permission)
WHERE g.key IN ('administrators', 'super_moderators')
ON CONFLICT (group_id, key) DO NOTHING;

GRANT SELECT, REFERENCES ON core.posts TO pii_owner;
GRANT SELECT ON core.topics, core.forums, core.board_settings TO pii_owner;

RESET ROLE;

GRANT SELECT ON core.ip_bans TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.ip_bans TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.ip_bans_id_seq TO staff_api;
GRANT SELECT ON core.member_bans TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.member_bans TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.member_bans_id_seq TO staff_api;

-- ---------------------------------------------------------------------------------------------
-- Restricted IP records and audited grants
-- ---------------------------------------------------------------------------------------------

SET LOCAL ROLE pii_owner;

CREATE TABLE IF NOT EXISTS pii.post_ips (
  post_id bigint PRIMARY KEY REFERENCES core.posts (id) ON DELETE CASCADE,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  ip inet NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS post_ips_ip_created_idx ON pii.post_ips (ip, created_at DESC);
CREATE INDEX IF NOT EXISTS post_ips_member_idx ON pii.post_ips (member_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pii.access_grants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  subject_member_id bigint,
  purpose text NOT NULL CHECK (purpose IN ('post_ip', 'reverse_ip', 'login_ips')),
  resource_type text NOT NULL,
  resource_id bigint NOT NULL,
  xact_id xid8 NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_grants_expiry_idx ON pii.access_grants (expires_at);

ALTER TABLE pii.post_ips ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii.post_ips FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS post_ips_owner_all ON pii.post_ips;
CREATE POLICY post_ips_owner_all ON pii.post_ips
  FOR ALL TO pii_owner USING (true) WITH CHECK (true);

ALTER TABLE pii.access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii.access_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS access_grants_owner_all ON pii.access_grants;
CREATE POLICY access_grants_owner_all ON pii.access_grants
  FOR ALL TO pii_owner USING (true) WITH CHECK (true);

REVOKE ALL ON pii.post_ips, pii.access_grants FROM PUBLIC, user_app, user_api, staff_api, workers;

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
  v_member_id bigint;
  v_forum_id bigint;
  v_subject bigint;
  v_grant_id bigint;
BEGIN
  IF p_session_token IS NULL OR p_session_token = '' OR p_purpose NOT IN ('post_ip', 'reverse_ip', 'login_ips') THEN
    RETURN NULL;
  END IF;

  SELECT s.member_id INTO v_member_id
    FROM core.sessions s
   WHERE s.token_hash = sha256(convert_to(p_session_token, 'UTF8'))
     AND s.kind = 'staff'
     AND s.revoked_at IS NULL
     AND s.last_seen_at > now() - interval '2 hours'
     AND s.created_at > now() - interval '12 hours'
     AND s.last_auth_at > now() - interval '15 minutes';

  IF NOT FOUND THEN
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

    IF NOT FOUND OR NOT core.has_mod_power(v_member_id, v_forum_id, 'view_ips') THEN
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

CREATE OR REPLACE FUNCTION pii.read_post_ip(p_grant_id bigint)
RETURNS TABLE (ip text, expired boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_grant pii.access_grants%ROWTYPE;
  v_retention integer;
  v_created timestamptz;
  v_ip inet;
BEGIN
  SELECT * INTO v_grant FROM pii.access_grants
   WHERE id = p_grant_id
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

CREATE OR REPLACE FUNCTION pii.read_members_by_ip(p_grant_id bigint)
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
  v_grant pii.access_grants%ROWTYPE;
  v_ip inet;
  v_retention integer;
BEGIN
  SELECT * INTO v_grant FROM pii.access_grants
   WHERE id = p_grant_id
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

CREATE OR REPLACE FUNCTION pii.read_login_ips(p_grant_id bigint)
RETURNS TABLE (ip text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_grant pii.access_grants%ROWTYPE;
  v_retention integer;
BEGIN
  SELECT * INTO v_grant FROM pii.access_grants
   WHERE id = p_grant_id
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

CREATE OR REPLACE FUNCTION pii.record_post_ip(p_post_id bigint, p_ip inet)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
  INSERT INTO pii.post_ips (post_id, member_id, ip)
  SELECT p.id, p.author_id, p_ip
    FROM core.posts p
   WHERE p.id = p_post_id AND p.author_id IS NOT NULL
  ON CONFLICT (post_id) DO NOTHING;
$$;

CREATE OR REPLACE FUNCTION pii.purge_expired()
RETURNS TABLE (post_ips bigint, login_ips bigint, access_log bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_days integer;
  v_post_ips bigint;
  v_login_ips bigint;
  v_access bigint;
BEGIN
  SELECT ip_retention_days INTO v_days FROM core.board_settings WHERE id = 1;

  DELETE FROM pii.post_ips
   WHERE created_at < now() - make_interval(days => v_days);
  GET DIAGNOSTICS v_post_ips = ROW_COUNT;

  DELETE FROM pii.ip_log
   WHERE created_at < now() - make_interval(days => v_days);
  GET DIAGNOSTICS v_login_ips = ROW_COUNT;

  DELETE FROM pii.access_log
   WHERE created_at < now() - interval '2 years';
  GET DIAGNOSTICS v_access = ROW_COUNT;

  RETURN QUERY SELECT v_post_ips, v_login_ips, v_access;
END;
$$;

REVOKE ALL ON FUNCTION pii.open_access(text, text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.read_post_ip(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.read_members_by_ip(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.read_login_ips(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.record_post_ip(bigint, inet) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.purge_expired() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION pii.open_access(text, text, text, bigint) TO staff_api;
GRANT EXECUTE ON FUNCTION pii.read_post_ip(bigint) TO staff_api;
GRANT EXECUTE ON FUNCTION pii.read_members_by_ip(bigint) TO staff_api;
GRANT EXECUTE ON FUNCTION pii.read_login_ips(bigint) TO staff_api;
GRANT EXECUTE ON FUNCTION pii.record_post_ip(bigint, inet) TO user_api;
GRANT EXECUTE ON FUNCTION pii.purge_expired() TO workers;

RESET ROLE;
