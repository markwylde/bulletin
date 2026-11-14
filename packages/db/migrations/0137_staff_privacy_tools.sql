-- 0137: staff queue reads the erasure post choice and can set it before processing
-- (ADR 0012; privacy-gdpr tasks 4.1, 5.1).

SET LOCAL ROLE pii_owner;

DROP FUNCTION IF EXISTS pii.list_data_requests(text, jsonb);

CREATE OR REPLACE FUNCTION pii.list_data_requests(
  p_session_token text,
  p_filters jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (
  id bigint,
  member_id bigint,
  kind text,
  status text,
  reason text,
  decision_reason text,
  post_action text,
  created_at timestamptz,
  updated_at timestamptz,
  due_at timestamptz,
  completed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_actor bigint;
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_member_filter bigint;
  v_has_overdue boolean := v_filters ? 'overdue';
  v_overdue boolean := coalesce((v_filters ->> 'overdue') = 'true', false);
BEGIN
  v_actor := pii.staff_session_member(p_session_token);

  IF v_actor IS NULL OR NOT core.has_acp(v_actor, 'privacy.requests') THEN
    RETURN;
  END IF;

  IF (v_filters ->> 'member_id') ~ '^[0-9]+$' THEN
    v_member_filter := (v_filters ->> 'member_id')::bigint;
  END IF;

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type
  ) VALUES (
    v_actor, v_member_filter, 'request_queue', 'data_request'
  );

  RETURN QUERY
    SELECT r.id,
           r.member_id,
           r.kind,
           r.status,
           r.reason,
           r.decision_reason,
           r.post_action,
           r.created_at,
           r.updated_at,
           r.due_at,
           r.completed_at
      FROM pii.data_requests r
     WHERE (nullif(v_filters ->> 'status', '') IS NULL
            OR r.status = (v_filters ->> 'status'))
       AND (nullif(v_filters ->> 'kind', '') IS NULL
            OR r.kind = (v_filters ->> 'kind'))
       AND (v_member_filter IS NULL OR r.member_id = v_member_filter)
       AND (NOT v_has_overdue
            OR ((r.due_at < now() AND r.status IN ('pending', 'processing')) = v_overdue))
     ORDER BY r.due_at, r.id
     LIMIT 200;
END;
$$;

CREATE OR REPLACE FUNCTION pii.set_data_request_post_action(
  p_session_token text,
  p_request_id bigint,
  p_post_action text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_actor bigint;
  v_member_id bigint;
BEGIN
  v_actor := pii.staff_session_member(p_session_token);

  IF v_actor IS NULL OR NOT core.has_acp(v_actor, 'privacy.requests') THEN
    RETURN false;
  END IF;

  IF p_post_action IS NULL OR p_post_action NOT IN ('anonymise', 'delete') THEN
    RETURN false;
  END IF;

  UPDATE pii.data_requests
     SET post_action = p_post_action, updated_at = now()
   WHERE id = p_request_id
     AND kind = 'erasure'
     AND status IN ('pending', 'processing')
  RETURNING member_id INTO v_member_id;

  IF v_member_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  ) VALUES (
    v_actor, v_member_id, 'request_update', 'data_request', p_request_id::text
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION pii.list_data_requests(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.set_data_request_post_action(text, bigint, text) FROM PUBLIC;

RESET ROLE;

GRANT EXECUTE ON FUNCTION pii.list_data_requests(text, jsonb) TO staff_api;
GRANT EXECUTE ON FUNCTION pii.set_data_request_post_action(text, bigint, text) TO staff_api;
