-- 0009: restricted PII schema and system-purpose definer functions (ADR 0012).
-- App roles have no privileges on these tables; access is only through the functions below.

SET LOCAL ROLE bulletin_owner;

-- The identity resolver creates the member row for a first login; it reads sessions to
-- derive the actor for `list_own_sessions`. Both are narrowly scoped.
GRANT USAGE ON SCHEMA core TO pii_owner;
GRANT SELECT, INSERT, REFERENCES ON core.members TO pii_owner;
GRANT USAGE, SELECT ON SEQUENCE core.members_id_seq TO pii_owner;
GRANT SELECT, REFERENCES ON core.sessions TO pii_owner;

RESET ROLE;

SET LOCAL ROLE pii_owner;

CREATE TABLE IF NOT EXISTS pii.identities (
  member_id bigint PRIMARY KEY REFERENCES core.members (id) ON DELETE CASCADE,
  issuer text NOT NULL CHECK (char_length(btrim(issuer)) > 0),
  sub text NOT NULL CHECK (char_length(btrim(sub)) > 0),
  email text,
  idp_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identities_issuer_sub_key UNIQUE (issuer, sub)
);

CREATE TABLE IF NOT EXISTS pii.session_meta (
  session_id bigint PRIMARY KEY REFERENCES core.sessions (id) ON DELETE CASCADE,
  ip inet NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pii.ip_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  ip inet NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ip_log_member_created_idx
  ON pii.ip_log (member_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pii.access_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_member_id bigint,
  subject_member_id bigint,
  purpose text NOT NULL CHECK (char_length(btrim(purpose)) > 0),
  resource_type text,
  resource_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_log_subject_created_idx
  ON pii.access_log (subject_member_id, created_at DESC);

CREATE INDEX IF NOT EXISTS access_log_created_idx ON pii.access_log (created_at);

-- Defence in depth: RLS is enabled and forced, and only the owner passes the policy.
ALTER TABLE pii.identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii.identities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS identities_owner_all ON pii.identities;
CREATE POLICY identities_owner_all ON pii.identities
  FOR ALL TO pii_owner USING (true) WITH CHECK (true);

ALTER TABLE pii.session_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii.session_meta FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_meta_owner_all ON pii.session_meta;
CREATE POLICY session_meta_owner_all ON pii.session_meta
  FOR ALL TO pii_owner USING (true) WITH CHECK (true);

ALTER TABLE pii.ip_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii.ip_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ip_log_owner_all ON pii.ip_log;
CREATE POLICY ip_log_owner_all ON pii.ip_log
  FOR ALL TO pii_owner USING (true) WITH CHECK (true);

ALTER TABLE pii.access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii.access_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS access_log_owner_all ON pii.access_log;
CREATE POLICY access_log_owner_all ON pii.access_log
  FOR ALL TO pii_owner USING (true) WITH CHECK (true);

REVOKE ALL ON pii.identities, pii.session_meta, pii.ip_log, pii.access_log
  FROM PUBLIC, user_app, user_api, staff_api, workers;

-- Only the interactive roles may call the functions, and the schema must be reachable for
-- qualified calls. No table privileges are granted.
GRANT USAGE ON SCHEMA pii TO user_api, staff_api;

CREATE OR REPLACE FUNCTION pii.resolve_identity(
  p_issuer text,
  p_sub text,
  p_email text,
  p_name text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_issuer text := nullif(btrim(p_issuer), '');
  v_sub text := nullif(btrim(p_sub), '');
  v_email text := nullif(btrim(p_email), '');
  v_name text := nullif(btrim(p_name), '');
  v_member_id bigint;
  v_stored_email text;
  v_stored_name text;
BEGIN
  IF v_issuer IS NULL OR v_sub IS NULL THEN
    RAISE EXCEPTION 'issuer and subject are required' USING ERRCODE = '22023';
  END IF;

  -- Serialise concurrent first logins for the same external identity.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_issuer || E'\x1f' || v_sub, 0));

  SELECT member_id, email, idp_name
    INTO v_member_id, v_stored_email, v_stored_name
    FROM pii.identities
   WHERE issuer = v_issuer AND sub = v_sub;

  IF FOUND THEN
    IF v_email IS NOT NULL AND v_email IS DISTINCT FROM v_stored_email THEN
      UPDATE pii.identities
         SET email = v_email, updated_at = now()
       WHERE member_id = v_member_id;

      INSERT INTO pii.access_log (actor_member_id, subject_member_id, purpose, resource_type, resource_id)
      VALUES (v_member_id, v_member_id, 'login', 'identity', v_member_id::text);
    END IF;

    IF v_name IS NOT NULL AND v_name IS DISTINCT FROM v_stored_name THEN
      UPDATE pii.identities
         SET idp_name = v_name, updated_at = now()
       WHERE member_id = v_member_id;
    END IF;

    RETURN v_member_id;
  END IF;

  INSERT INTO core.members DEFAULT VALUES
  RETURNING id INTO v_member_id;

  INSERT INTO pii.identities (member_id, issuer, sub, email, idp_name)
  VALUES (v_member_id, v_issuer, v_sub, v_email, v_name);

  INSERT INTO pii.access_log (actor_member_id, subject_member_id, purpose, resource_type, resource_id)
  VALUES (v_member_id, v_member_id, 'login', 'identity', v_member_id::text);

  RETURN v_member_id;
END;
$$;

CREATE OR REPLACE FUNCTION pii.record_session_meta(
  p_session_id bigint,
  p_ip inet,
  p_user_agent text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
BEGIN
  INSERT INTO pii.session_meta (session_id, ip, user_agent)
  VALUES (p_session_id, p_ip, nullif(btrim(p_user_agent), ''))
  ON CONFLICT (session_id) DO UPDATE
     SET ip = EXCLUDED.ip,
         user_agent = coalesce(EXCLUDED.user_agent, pii.session_meta.user_agent),
         updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION pii.record_login_ip(
  p_member_id bigint,
  p_ip inet
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
  INSERT INTO pii.ip_log (member_id, ip) VALUES (p_member_id, p_ip);
$$;

REVOKE ALL ON FUNCTION pii.resolve_identity(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.record_session_meta(bigint, inet, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.record_login_ip(bigint, inet) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION pii.resolve_identity(text, text, text, text) TO user_api, staff_api;
GRANT EXECUTE ON FUNCTION pii.record_session_meta(bigint, inet, text) TO user_api, staff_api;
GRANT EXECUTE ON FUNCTION pii.record_login_ip(bigint, inet) TO user_api, staff_api;

RESET ROLE;
