-- 0135: member data export (ADR 0012; privacy-gdpr 3.1).
--
-- The export job runs as `workers`; restricted identity/network data leaves `pii` only through
-- `pii.export_member(request_id)`. The download route returns a 60-second presigned object URL
-- after `pii.export_download_target` re-checks the session member and expiry.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.notifications
  ADD COLUMN IF NOT EXISTS data_request_id bigint;

CREATE INDEX IF NOT EXISTS notifications_data_request_idx
  ON core.notifications (data_request_id)
  WHERE data_request_id IS NOT NULL;

COMMENT ON COLUMN core.notifications.data_request_id
  IS '@personal class=restricted';

RESET ROLE;

-- The export worker reads the member's settings, profile fields and badges directly.
GRANT SELECT ON
  core.member_field_values,
  core.profile_fields,
  core.member_badges,
  core.badges,
  core.digest_subscriptions
TO workers;

SET LOCAL ROLE pii_owner;

-- The restricted half of the archive. One call per request; it records the access against the
-- request before returning anything, and only ever returns the request's own member.
CREATE OR REPLACE FUNCTION pii.export_member(p_request_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
  v_status text;
  v_result jsonb;
BEGIN
  SELECT member_id, status INTO v_member_id, v_status
    FROM pii.data_requests
   WHERE id = p_request_id AND kind = 'export';

  IF NOT FOUND OR v_status NOT IN ('processing', 'completed') THEN
    RETURN NULL;
  END IF;

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  ) VALUES (
    NULL, v_member_id, 'export', 'data_request', p_request_id::text
  );

  SELECT jsonb_build_object(
    'memberId', v_member_id::text,
    'identity', (
      SELECT jsonb_build_object(
        'issuer', i.issuer,
        'subject', i.sub,
        'email', i.email,
        'identityProviderName', i.idp_name,
        'createdAt', i.created_at,
        'updatedAt', i.updated_at
      )
      FROM pii.identities i
      WHERE i.member_id = v_member_id
    ),
    'sessions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', s.id::text,
        'kind', s.kind,
        'createdAt', s.created_at,
        'lastSeenAt', s.last_seen_at,
        'lastAuthAt', s.last_auth_at,
        'revokedAt', s.revoked_at,
        'ip', host(m.ip),
        'userAgent', m.user_agent
      ) ORDER BY s.created_at DESC, s.id DESC)
      FROM core.sessions s
      LEFT JOIN pii.session_meta m ON m.session_id = s.id
      WHERE s.member_id = v_member_id
    ), '[]'::jsonb),
    'loginIps', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('ip', host(l.ip), 'createdAt', l.created_at)
                       ORDER BY l.created_at DESC, l.id DESC)
      FROM pii.ip_log l
      WHERE l.member_id = v_member_id
    ), '[]'::jsonb),
    'postIps', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'postId', pi.post_id::text, 'ip', host(pi.ip), 'createdAt', pi.created_at
      ) ORDER BY pi.created_at DESC)
      FROM pii.post_ips pi
      WHERE pi.member_id = v_member_id
    ), '[]'::jsonb),
    'accessLog', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'purpose', a.purpose,
        'resourceType', a.resource_type,
        'resourceId', a.resource_id,
        'createdAt', a.created_at
      ) ORDER BY a.created_at DESC, a.id DESC)
      FROM pii.access_log a
      WHERE a.subject_member_id = v_member_id
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- Starts (or resumes) one export request. Null means there is nothing to build.
CREATE OR REPLACE FUNCTION pii.begin_export(p_request_id bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
BEGIN
  UPDATE pii.data_requests
     SET status = 'processing', updated_at = now()
   WHERE id = p_request_id
     AND kind = 'export'
     AND status IN ('pending', 'processing')
  RETURNING member_id INTO v_member_id;

  IF v_member_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  ) VALUES (
    NULL, v_member_id, 'export', 'data_request', p_request_id::text
  );

  RETURN v_member_id;
END;
$$;

-- Stores the archive key, marks the request complete and records the expiry.
CREATE OR REPLACE FUNCTION pii.complete_export(
  p_request_id bigint,
  p_export_key text,
  p_expires_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
BEGIN
  IF p_export_key IS NULL OR btrim(p_export_key) = '' OR p_expires_at IS NULL THEN
    RETURN false;
  END IF;

  UPDATE pii.data_requests
     SET status = 'completed',
         export_key = p_export_key,
         export_expires_at = p_expires_at,
         completed_at = now(),
         updated_at = now()
   WHERE id = p_request_id
     AND kind = 'export'
     AND status = 'processing'
  RETURNING member_id INTO v_member_id;

  IF v_member_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  ) VALUES (
    NULL, v_member_id, 'export', 'data_request', p_request_id::text
  );

  RETURN true;
END;
$$;

-- The authenticated download check. It takes the raw user session cookie, derives the member,
-- verifies the request belongs to them and has not expired, then audits the own-data access.
CREATE OR REPLACE FUNCTION pii.export_download_target(
  p_session_token text,
  p_request_id bigint
) RETURNS TABLE (export_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
  v_state text;
  v_key text;
BEGIN
  v_member_id := pii.user_session_member(p_session_token);

  IF v_member_id IS NULL THEN
    RETURN;
  END IF;

  SELECT state INTO v_state FROM core.members WHERE id = v_member_id;

  IF v_state IS DISTINCT FROM 'active' THEN
    RETURN;
  END IF;

  SELECT r.export_key INTO v_key
    FROM pii.data_requests r
   WHERE r.id = p_request_id
     AND r.member_id = v_member_id
     AND r.kind = 'export'
     AND r.status = 'completed'
     AND r.export_key IS NOT NULL
     AND r.export_expires_at IS NOT NULL
     AND r.export_expires_at > now();

  IF v_key IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  ) VALUES (
    v_member_id, v_member_id, 'own_data', 'data_request', p_request_id::text
  );

  RETURN QUERY SELECT v_key;
END;
$$;

REVOKE ALL ON FUNCTION pii.export_member(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.begin_export(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.complete_export(bigint, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.export_download_target(text, bigint) FROM PUBLIC;

RESET ROLE;

GRANT EXECUTE ON FUNCTION pii.export_member(bigint) TO workers;
GRANT EXECUTE ON FUNCTION pii.begin_export(bigint) TO workers;
GRANT EXECUTE ON FUNCTION pii.complete_export(bigint, text, timestamptz) TO workers;
GRANT EXECUTE ON FUNCTION pii.export_download_target(text, bigint) TO user_api;
