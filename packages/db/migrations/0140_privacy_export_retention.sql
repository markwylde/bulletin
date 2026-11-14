-- 0140: review fixes for abandoned export archives and the missing export sections
-- (ADR 0012; privacy-gdpr review).

SET LOCAL ROLE pii_owner;

-- A processing export can be rejected after its upload key was reserved. A crash between the
-- upload and the completion transaction, or a failed object deletion, must not leave the PII
-- archive behind for the request's full two-year accountability window. Completed archives
-- still follow the archive expiry; every other status is reconciled after a one-day grace.
CREATE OR REPLACE FUNCTION pii.expired_exports(p_now timestamptz DEFAULT now())
RETURNS TABLE (request_id bigint, export_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT r.id, r.export_key
      FROM pii.data_requests r
     WHERE r.export_key IS NOT NULL
       AND (
         (r.status = 'completed'
           AND r.export_expires_at IS NOT NULL
           AND r.export_expires_at <= p_now)
         OR (r.status IN ('processing', 'rejected', 'cancelled')
           AND COALESCE(
                 r.export_started_at, r.completed_at, r.updated_at, r.created_at
               ) <= p_now - interval '1 day')
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
BEGIN
  UPDATE pii.data_requests r
     SET export_key = NULL,
         export_expires_at = NULL,
         updated_at = p_now
   WHERE r.id = p_request_id
     AND r.export_key IS NOT NULL
     AND (
       (r.status = 'completed'
         AND r.export_expires_at IS NOT NULL
         AND r.export_expires_at <= p_now)
       OR (r.status IN ('processing', 'rejected', 'cancelled')
         AND COALESCE(
               r.export_started_at, r.completed_at, r.updated_at, r.created_at
             ) <= p_now - interval '1 day')
     );

  RETURN FOUND;
END;
$$;

-- The restricted half of the archive. One call per request; it records the access against the
-- request before returning anything, and only ever returns the request's own member. The
-- member's own request records are included (design checklist), without staff-only fields.
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
    ), '[]'::jsonb),
    'dataRequests', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', r.id::text,
        'kind', r.kind,
        'status', r.status,
        'reason', r.reason,
        'decisionReason', r.decision_reason,
        'postAction', r.post_action,
        'createdAt', r.created_at,
        'updatedAt', r.updated_at,
        'dueAt', r.due_at,
        'completedAt', r.completed_at
      ) ORDER BY r.created_at DESC, r.id DESC)
      FROM pii.data_requests r
      WHERE r.member_id = v_member_id
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION pii.expired_exports(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.clear_expired_export(bigint, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.export_member(bigint) FROM PUBLIC;

RESET ROLE;

GRANT EXECUTE ON FUNCTION pii.expired_exports(timestamptz) TO workers;
GRANT EXECUTE ON FUNCTION pii.clear_expired_export(bigint, timestamptz) TO workers;
GRANT EXECUTE ON FUNCTION pii.export_member(bigint) TO workers;
