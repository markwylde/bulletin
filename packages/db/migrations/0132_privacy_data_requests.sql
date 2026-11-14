-- 0132: data subject requests, their step journal and audited PII-log reads
-- (ADR 0012; privacy-gdpr task 1.3).
--
-- The request rows are restricted data: members use their own session to open a request, and
-- staff reach the queue only through definer functions that check `privacy.requests` in SQL.
-- Reading the audit log is a two-transaction grant, like the IP lookup functions.

SET LOCAL ROLE bulletin_owner;

INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, p.permission, to_jsonb(true)
FROM core.groups g
CROSS JOIN (
  VALUES ('privacy.requests'), ('privacy.audit')
) AS p (permission)
WHERE g.key = 'administrators'
ON CONFLICT (group_id, key) DO NOTHING;

RESET ROLE;

SET LOCAL ROLE pii_owner;

CREATE TABLE IF NOT EXISTS pii.data_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('export', 'erasure')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'rejected')),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 2_000),
  decision_reason text CHECK (decision_reason IS NULL OR char_length(decision_reason) <= 2_000),
  decided_by bigint REFERENCES core.members (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  completed_at timestamptz
);

-- One open request per kind (ADR 0012). A completed or rejected request does not block a new
-- one; the member may ask again after the previous request has been decided.
CREATE UNIQUE INDEX IF NOT EXISTS data_requests_open_key
  ON pii.data_requests (member_id, kind)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS data_requests_queue_idx
  ON pii.data_requests (status, due_at, id);

CREATE TABLE IF NOT EXISTS pii.data_request_steps (
  request_id bigint NOT NULL REFERENCES pii.data_requests (id) ON DELETE CASCADE,
  step text NOT NULL CHECK (char_length(btrim(step)) BETWEEN 1 AND 80),
  state text NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (request_id, step)
);

CREATE INDEX IF NOT EXISTS data_request_steps_state_idx
  ON pii.data_request_steps (request_id, state, started_at);

ALTER TABLE pii.data_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii.data_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS data_requests_owner_all ON pii.data_requests;
CREATE POLICY data_requests_owner_all ON pii.data_requests
  FOR ALL TO pii_owner USING (true) WITH CHECK (true);

ALTER TABLE pii.data_request_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii.data_request_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS data_request_steps_owner_all ON pii.data_request_steps;
CREATE POLICY data_request_steps_owner_all ON pii.data_request_steps
  FOR ALL TO pii_owner USING (true) WITH CHECK (true);

REVOKE ALL ON pii.data_requests, pii.data_request_steps
  FROM PUBLIC, user_app, user_api, staff_api, workers;

-- The audit grant table predates the audit viewer. Extend its purpose vocabulary rather than
-- creating a second grant table.
ALTER TABLE pii.access_grants DROP CONSTRAINT IF EXISTS access_grants_purpose_check;
ALTER TABLE pii.access_grants
  ADD CONSTRAINT access_grants_purpose_check
  CHECK (purpose IN ('post_ip', 'reverse_ip', 'login_ips', 'access_log'));

-- A staff session for the request queue. Unlike `pii.session_for_token`, this does not demand
-- a recent step-up: the queue is ordinary ACP work, not an IP disclosure.
CREATE OR REPLACE FUNCTION pii.staff_session_member(p_session_token text)
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
   LIMIT 1
$$;

-- Members open their own requests. The actor comes from the user session, never from the
-- caller. The existing open request is returned, so a double click is idempotent.
CREATE OR REPLACE FUNCTION pii.create_data_request(
  p_session_token text,
  p_kind text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
  v_state text;
  v_request_id bigint;
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('export', 'erasure') THEN
    RETURN NULL;
  END IF;

  v_member_id := pii.user_session_member(p_session_token);

  IF v_member_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT state INTO v_state FROM core.members WHERE id = v_member_id;

  IF v_state IS DISTINCT FROM 'active' THEN
    RETURN NULL;
  END IF;

  INSERT INTO pii.data_requests (member_id, kind)
  VALUES (v_member_id, p_kind)
  ON CONFLICT (member_id, kind) WHERE status IN ('pending', 'processing') DO NOTHING
  RETURNING id INTO v_request_id;

  IF v_request_id IS NULL THEN
    SELECT id INTO v_request_id
      FROM pii.data_requests
     WHERE member_id = v_member_id
       AND kind = p_kind
       AND status IN ('pending', 'processing')
     ORDER BY id DESC
     LIMIT 1;
  END IF;

  IF v_request_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  ) VALUES (
    v_member_id, v_member_id, 'own_data', 'data_request', v_request_id::text
  );

  RETURN v_request_id;
END;
$$;

-- The staff queue. Filters are JSON: status, kind, member_id, overdue (boolean).
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

-- Staff decisions. `process` moves a pending request into work, `complete` finishes it and
-- `reject` closes it with a required reason. Every update writes an audit row.
CREATE OR REPLACE FUNCTION pii.update_data_request(
  p_session_token text,
  p_request_id bigint,
  p_action text,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_actor bigint;
  v_member_id bigint;
  v_status text;
  v_reason text := nullif(btrim(p_reason), '');
BEGIN
  v_actor := pii.staff_session_member(p_session_token);

  IF v_actor IS NULL OR NOT core.has_acp(v_actor, 'privacy.requests') THEN
    RETURN;
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('process', 'complete', 'reject') THEN
    RETURN;
  END IF;

  IF p_action = 'reject' AND v_reason IS NULL THEN
    RETURN;
  END IF;

  SELECT member_id, status INTO v_member_id, v_status
    FROM pii.data_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_action = 'process' AND v_status <> 'pending' THEN
    RETURN;
  END IF;

  IF p_action = 'complete' AND v_status <> 'processing' THEN
    RETURN;
  END IF;

  IF p_action = 'reject' AND v_status NOT IN ('pending', 'processing') THEN
    RETURN;
  END IF;

  UPDATE pii.data_requests
     SET status = CASE p_action
                    WHEN 'process' THEN 'processing'
                    WHEN 'complete' THEN 'completed'
                    ELSE 'rejected'
                  END,
         decision_reason = v_reason,
         decided_by = v_actor,
         updated_at = now(),
         completed_at = CASE WHEN p_action = 'process' THEN NULL ELSE now() END
   WHERE id = p_request_id;

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  ) VALUES (
    v_actor, v_member_id, 'request_update', 'data_request', p_request_id::text
  );
END;
$$;

-- Workers record each ordered erasure/export step. Re-running a step is idempotent: the same
-- row is updated, and a retry can move a failed step back to running.
CREATE OR REPLACE FUNCTION pii.update_request_step(
  p_request_id bigint,
  p_step text,
  p_state text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
BEGIN
  IF p_step IS NULL OR btrim(p_step) = '' OR char_length(p_step) > 80 THEN
    RETURN;
  END IF;

  IF p_state IS NULL OR p_state NOT IN ('running', 'completed', 'failed') THEN
    RETURN;
  END IF;

  SELECT member_id INTO v_member_id FROM pii.data_requests WHERE id = p_request_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO pii.data_request_steps (request_id, step, state, completed_at)
  VALUES (
    p_request_id, p_step, p_state,
    CASE WHEN p_state = 'completed' THEN now() END
  )
  ON CONFLICT (request_id, step) DO UPDATE
     SET state = EXCLUDED.state,
         error = NULL,
         updated_at = now(),
         completed_at = CASE
                          WHEN EXCLUDED.state = 'completed' THEN now()
                          ELSE NULL
                        END;

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  ) VALUES (
    NULL, v_member_id, 'request_step', 'data_request', p_request_id::text
  );
END;
$$;

-- Reads the audit log through a committed two-transaction grant. Filters are JSON:
-- actor_member_id, subject_member_id, purpose, from, to, limit.
CREATE OR REPLACE FUNCTION pii.read_access_log(
  p_session_token text,
  p_grant_id bigint,
  p_filters jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (
  id bigint,
  actor_member_id bigint,
  subject_member_id bigint,
  purpose text,
  resource_type text,
  resource_id text,
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
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_actor_filter bigint;
  v_subject_filter bigint;
  v_from timestamptz;
  v_to timestamptz;
  v_limit integer;
BEGIN
  SELECT s.session_id, s.actor_member_id
    INTO v_session_id, v_actor
    FROM pii.session_for_token(p_session_token) s;

  IF v_actor IS NULL THEN
    RETURN;
  END IF;

  SELECT g.* INTO v_grant FROM pii.access_grants g
   WHERE g.id = p_grant_id
     AND g.actor_member_id = v_actor
     AND g.purpose = 'access_log'
     AND g.resource_type = 'access_log'
     AND g.consumed_at IS NULL
     AND g.expires_at > now()
   FOR UPDATE;

  IF NOT FOUND OR pg_xact_status(v_grant.xact_id) <> 'committed' THEN
    RETURN;
  END IF;

  IF NOT core.has_acp(v_actor, 'privacy.audit') THEN
    RETURN;
  END IF;

  IF (v_filters ->> 'actor_member_id') ~ '^[0-9]+$' THEN
    v_actor_filter := (v_filters ->> 'actor_member_id')::bigint;
  END IF;

  IF (v_filters ->> 'subject_member_id') ~ '^[0-9]+$' THEN
    v_subject_filter := (v_filters ->> 'subject_member_id')::bigint;
  END IF;

  IF (v_filters ->> 'from') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
    v_from := (v_filters ->> 'from')::timestamptz;
  END IF;

  IF (v_filters ->> 'to') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
    v_to := (v_filters ->> 'to')::timestamptz;
  END IF;

  v_limit := CASE
    WHEN (v_filters ->> 'limit') ~ '^[0-9]+$'
      THEN least(greatest((v_filters ->> 'limit')::integer, 1), 500)
    ELSE 200
  END;

  UPDATE pii.access_grants g
     SET consumed_at = now()
   WHERE g.id = p_grant_id;

  RETURN QUERY
    SELECT l.id,
           l.actor_member_id,
           l.subject_member_id,
           l.purpose,
           l.resource_type,
           l.resource_id,
           l.created_at
      FROM pii.access_log l
     WHERE (v_actor_filter IS NULL OR l.actor_member_id = v_actor_filter)
       AND (v_subject_filter IS NULL OR l.subject_member_id = v_subject_filter)
       AND (nullif(v_filters ->> 'purpose', '') IS NULL
            OR l.purpose = (v_filters ->> 'purpose'))
       AND (v_from IS NULL OR l.created_at >= v_from)
       AND (v_to IS NULL OR l.created_at <= v_to)
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT v_limit;
END;
$$;

-- The audit viewer opens the same kind of single-use grant as the IP tools. Only
-- `privacy.audit` may open it, and the read redeems it after the audit row commits.
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
  IF p_session_token IS NULL OR p_session_token = ''
     OR p_purpose NOT IN ('post_ip', 'reverse_ip', 'login_ips', 'access_log')
  THEN
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
  ELSIF p_purpose = 'login_ips' THEN
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
  ELSE
    IF p_resource_type <> 'access_log' OR NOT core.has_acp(v_member_id, 'privacy.audit') THEN
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

REVOKE ALL ON FUNCTION pii.staff_session_member(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.create_data_request(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.list_data_requests(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.update_data_request(text, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.update_request_step(bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.read_access_log(text, bigint, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.open_access(text, text, text, bigint) FROM PUBLIC;

RESET ROLE;

GRANT EXECUTE ON FUNCTION pii.create_data_request(text, text) TO user_api;
GRANT EXECUTE ON FUNCTION pii.list_data_requests(text, jsonb) TO staff_api;
GRANT EXECUTE ON FUNCTION pii.update_data_request(text, bigint, text, text) TO staff_api;
GRANT EXECUTE ON FUNCTION pii.update_request_step(bigint, text, text) TO workers;
GRANT EXECUTE ON FUNCTION pii.read_access_log(text, bigint, jsonb) TO staff_api;
GRANT EXECUTE ON FUNCTION pii.open_access(text, text, text, bigint) TO staff_api;
