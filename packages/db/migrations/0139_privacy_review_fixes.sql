-- 0139: review fixes for erasure durability, export fencing and retention boundaries
-- (ADR 0012; privacy-gdpr).

SET LOCAL ROLE bulletin_owner;

GRANT SELECT ON core.member_name_history TO pii_owner;

RESET ROLE;

SET LOCAL ROLE pii_owner;

ALTER TABLE pii.data_requests DROP CONSTRAINT IF EXISTS data_requests_status_check;
ALTER TABLE pii.data_requests
  ADD CONSTRAINT data_requests_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'rejected', 'cancelled'));

ALTER TABLE pii.data_requests
  ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE pii.data_requests
  ADD COLUMN IF NOT EXISTS export_started_at timestamptz;

COMMENT ON COLUMN pii.data_requests.last_error
  IS '@personal class=restricted';

COMMENT ON COLUMN pii.data_requests.export_started_at
  IS '@personal class=personal-content';

ALTER TABLE pii.erasure_fences
  ADD COLUMN IF NOT EXISTS old_names text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN pii.erasure_fences.old_names
  IS '@personal class=restricted';

-- Capture the names and cancel outstanding exports before any erasure step runs. The names
-- live in the fence so a retry after anonymisation can still rewrite mentions.
CREATE OR REPLACE FUNCTION pii.apply_erasure_fence(p_request_id bigint)
RETURNS TABLE (
  member_id bigint,
  session_ids bigint[],
  api_key_ids bigint[],
  push_device_ids bigint[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
  v_status text;
  v_sessions bigint[];
  v_keys bigint[];
  v_devices bigint[];
  v_old_names text[];
BEGIN
  SELECT r.member_id, r.status INTO v_member_id, v_status
    FROM pii.data_requests r
   WHERE r.id = p_request_id AND r.kind = 'erasure'
   FOR UPDATE;

  IF NOT FOUND OR v_status NOT IN ('pending', 'processing') THEN
    RETURN;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT name), '{}'::text[]) INTO v_old_names
    FROM (
      SELECT display_name AS name
        FROM core.members
       WHERE id = v_member_id AND display_name IS NOT NULL
      UNION
      SELECT h.old_name FROM core.member_name_history h WHERE h.member_id = v_member_id
      UNION
      SELECT h.new_name FROM core.member_name_history h WHERE h.member_id = v_member_id
    ) names
   WHERE btrim(name) <> '';

  UPDATE core.members
     SET state = 'erasing'
   WHERE id = v_member_id
     AND state = 'active';

  UPDATE pii.data_requests r
     SET status = 'cancelled',
         decision_reason = 'Member erasure accepted',
         updated_at = now()
   WHERE r.member_id = v_member_id
     AND r.kind = 'export'
     AND r.status IN ('pending', 'processing');

  WITH revoked AS (
    UPDATE core.sessions s
       SET revoked_at = COALESCE(s.revoked_at, now())
     WHERE s.member_id = v_member_id
       AND s.revoked_at IS NULL
     RETURNING s.id
  )
  SELECT COALESCE(array_agg(id), '{}'::bigint[]) INTO v_sessions FROM revoked;

  WITH revoked AS (
    UPDATE core.api_keys k
       SET revoked_at = COALESCE(k.revoked_at, now())
     WHERE k.principal_member_id = v_member_id
       AND k.revoked_at IS NULL
     RETURNING k.id
  )
  SELECT COALESCE(array_agg(id), '{}'::bigint[]) INTO v_keys FROM revoked;

  WITH removed AS (
    DELETE FROM pii.push_subscriptions p
     WHERE p.member_id = v_member_id
     RETURNING p.id
  )
  SELECT COALESCE(array_agg(id), '{}'::bigint[]) INTO v_devices FROM removed;

  INSERT INTO pii.erasure_fences (
    request_id, member_id, old_names, session_ids, api_key_ids, push_device_ids
  ) VALUES (
    p_request_id, v_member_id, v_old_names, v_sessions, v_keys, v_devices
  )
  ON CONFLICT (request_id) DO UPDATE
    SET old_names = CASE
      WHEN cardinality(pii.erasure_fences.old_names) = 0
        THEN EXCLUDED.old_names
      ELSE pii.erasure_fences.old_names
    END;

  RETURN QUERY
    SELECT f.member_id, f.session_ids, f.api_key_ids, f.push_device_ids
      FROM pii.erasure_fences f
     WHERE f.request_id = p_request_id;
END;
$$;

CREATE OR REPLACE FUNCTION pii.erasure_fence(p_request_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
  SELECT jsonb_build_object(
    'memberId', f.member_id::text,
    'oldNames', to_jsonb(f.old_names),
    'sessionIds', to_jsonb(f.session_ids::text[]),
    'apiKeyIds', to_jsonb(f.api_key_ids::text[]),
    'pushDeviceIds', to_jsonb(f.push_device_ids::text[]),
    'acceptedAt', f.created_at
  )
  FROM pii.erasure_fences f
  WHERE f.request_id = p_request_id
$$;

CREATE OR REPLACE FUNCTION pii.begin_erasure(p_request_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_row record;
  v_fence record;
  v_old_names text[];
BEGIN
  SELECT r.member_id, r.post_action, r.status
    INTO v_row
    FROM pii.data_requests r
   WHERE r.id = p_request_id AND r.kind = 'erasure'
   FOR UPDATE;

  IF NOT FOUND OR v_row.status = 'completed' THEN
    RETURN NULL;
  END IF;

  SELECT f.member_id, f.session_ids, f.api_key_ids, f.push_device_ids
    INTO v_fence
    FROM pii.apply_erasure_fence(p_request_id) f;

  IF v_fence.member_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT old_names INTO v_old_names FROM pii.erasure_fences WHERE request_id = p_request_id;

  UPDATE pii.data_requests
     SET status = 'processing',
         last_error = NULL,
         updated_at = now()
   WHERE id = p_request_id
     AND status = 'processing';

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  ) VALUES (
    NULL, v_fence.member_id, 'erasure', 'data_request', p_request_id::text
  );

  RETURN jsonb_build_object(
    'memberId', v_fence.member_id::text,
    'postAction', v_row.post_action,
    'oldNames', to_jsonb(v_old_names),
    'sessionIds', to_jsonb(v_fence.session_ids::text[]),
    'apiKeyIds', to_jsonb(v_fence.api_key_ids::text[]),
    'pushDeviceIds', to_jsonb(v_fence.push_device_ids::text[])
  );
END;
$$;

-- Persist the object key before the upload. A retry reuses the key, and retention can find
-- archives whose completion transaction never ran.
CREATE OR REPLACE FUNCTION pii.reserve_export_key(
  p_request_id bigint,
  p_export_key text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
  v_status text;
  v_existing text;
  v_state text;
BEGIN
  IF p_export_key IS NULL OR p_export_key !~ '^export/[0-9a-f-]+\.zip$' THEN
    RETURN NULL;
  END IF;

  SELECT r.member_id, r.status, r.export_key
    INTO v_member_id, v_status, v_existing
    FROM pii.data_requests r
   WHERE r.id = p_request_id AND r.kind = 'export'
   FOR UPDATE;

  IF NOT FOUND OR v_status <> 'processing' THEN
    RETURN NULL;
  END IF;

  SELECT state INTO v_state FROM core.members WHERE id = v_member_id;

  IF v_state IS DISTINCT FROM 'active' THEN
    RETURN NULL;
  END IF;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  UPDATE pii.data_requests
     SET export_key = p_export_key,
         export_started_at = now(),
         updated_at = now()
   WHERE id = p_request_id;

  RETURN p_export_key;
END;
$$;

-- Completion locks the member first, then the request, so it serialises with the fence and
-- refuses to publish anything once erasure has begun.
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
  v_status text;
  v_state text;
BEGIN
  IF p_export_key IS NULL OR btrim(p_export_key) = '' OR p_expires_at IS NULL THEN
    RETURN false;
  END IF;

  SELECT r.member_id, r.status INTO v_member_id, v_status
    FROM pii.data_requests r
   WHERE r.id = p_request_id AND r.kind = 'export';

  IF NOT FOUND OR v_status <> 'processing' THEN
    RETURN false;
  END IF;

  SELECT state INTO v_state FROM core.members WHERE id = v_member_id FOR UPDATE;

  IF v_state IS DISTINCT FROM 'active' THEN
    RETURN false;
  END IF;

  UPDATE pii.data_requests
     SET status = 'completed',
         export_key = p_export_key,
         export_expires_at = p_expires_at,
         completed_at = now(),
         updated_at = now(),
         last_error = NULL
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

CREATE OR REPLACE FUNCTION pii.export_failed(
  p_request_id bigint,
  p_error text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
BEGIN
  UPDATE pii.data_requests
     SET last_error = left(COALESCE(p_error, 'export failed'), 2_000),
         updated_at = now()
   WHERE id = p_request_id
     AND kind = 'export'
     AND status = 'processing';
END;
$$;

CREATE OR REPLACE FUNCTION pii.export_email_intent(p_request_id bigint)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
  SELECT i.id
    FROM core.delivery_intents i
    JOIN core.notifications n ON n.id = i.ref_id
   WHERE n.data_request_id = p_request_id
     AND i.kind = 'notification'
     AND i.channel = 'email'
     AND i.delivered_at IS NULL
   ORDER BY i.id
   LIMIT 1
$$;

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
  v_kind text;
  v_status text;
  v_reason text := nullif(btrim(p_reason), '');
BEGIN
  v_actor := pii.staff_session_member(p_session_token);

  IF v_actor IS NULL OR NOT core.has_acp(v_actor, 'privacy.requests') THEN
    RETURN;
  END IF;

  IF p_action IS NULL OR p_action NOT IN ('process', 'reject') THEN
    RETURN;
  END IF;

  IF p_action = 'reject' AND v_reason IS NULL THEN
    RETURN;
  END IF;

  SELECT member_id, kind, status INTO v_member_id, v_kind, v_status
    FROM pii.data_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF p_action = 'process' AND v_status <> 'pending' THEN
    RETURN;
  END IF;

  -- Once an erasure is accepted only the worker's verified completion may finish it.
  IF p_action = 'reject' AND v_kind = 'erasure' AND v_status = 'processing' THEN
    RETURN;
  END IF;

  IF p_action = 'reject' AND v_status NOT IN ('pending', 'processing') THEN
    RETURN;
  END IF;

  UPDATE pii.data_requests
     SET status = CASE p_action
                    WHEN 'process' THEN 'processing'
                    ELSE 'rejected'
                  END,
         decision_reason = v_reason,
         decided_by = v_actor,
         updated_at = now(),
         completed_at = CASE WHEN p_action = 'process' THEN NULL ELSE now() END
   WHERE id = p_request_id;

  IF p_action = 'process' AND v_kind = 'erasure' THEN
    PERFORM pii.apply_erasure_fence(p_request_id);

    INSERT INTO core.events (type, aggregate_type, aggregate_id, aggregate_version, payload_ids)
    VALUES (
      'privacy.erasure.accepted', 'data_request', p_request_id, 1,
      jsonb_build_object('requestId', p_request_id::text, 'memberId', v_member_id::text)
    );
  END IF;

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  ) VALUES (
    v_actor, v_member_id, 'request_update', 'data_request', p_request_id::text
  );
END;
$$;

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
  last_error text,
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
           r.last_error,
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

-- Export deadlines are the archive's own expiry, never the request's creation time.
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
         OR (r.status = 'processing'
           AND r.export_started_at IS NOT NULL
           AND r.export_started_at <= p_now - interval '1 day')
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
       OR (r.status = 'processing'
         AND r.export_started_at IS NOT NULL
         AND r.export_started_at <= p_now - interval '1 day')
     );

  RETURN FOUND;
END;
$$;

-- The erasure job asks for the keys first, deletes the objects, then clears the keys. A failed
-- object deletion therefore leaves the work for the next retry.
CREATE OR REPLACE FUNCTION pii.erasure_export_keys(p_request_id bigint)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
  v_keys text[];
BEGIN
  SELECT member_id INTO v_member_id
    FROM pii.data_requests
   WHERE id = p_request_id AND kind = 'erasure';

  IF NOT FOUND THEN
    RETURN '{}'::text[];
  END IF;

  SELECT COALESCE(array_agg(export_key), '{}'::text[]) INTO v_keys
    FROM pii.data_requests
   WHERE member_id = v_member_id AND export_key IS NOT NULL;

  RETURN v_keys;
END;
$$;

CREATE OR REPLACE FUNCTION pii.clear_erasure_export_keys(p_request_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
BEGIN
  SELECT member_id INTO v_member_id
    FROM pii.data_requests
   WHERE id = p_request_id AND kind = 'erasure';

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE pii.data_requests
     SET export_key = NULL, export_expires_at = NULL, updated_at = now()
   WHERE member_id = v_member_id AND export_key IS NOT NULL;
END;
$$;

DROP FUNCTION IF EXISTS pii.purge_expired(timestamptz);

CREATE OR REPLACE FUNCTION pii.purge_expired(p_now timestamptz DEFAULT now())
RETURNS TABLE (
  post_ips bigint,
  login_ips bigint,
  access_log bigint,
  session_meta bigint,
  data_requests bigint
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
  v_requests bigint;
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

  DELETE FROM pii.data_requests
   WHERE status IN ('completed', 'rejected', 'cancelled')
     AND COALESCE(completed_at, updated_at) < p_now - interval '2 years'
     AND export_key IS NULL;
  GET DIAGNOSTICS v_requests = ROW_COUNT;

  RETURN QUERY SELECT v_post_ips, v_login_ips, v_access, v_meta, v_requests;
END;
$$;

REVOKE ALL ON FUNCTION pii.apply_erasure_fence(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.erasure_fence(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.begin_erasure(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.complete_export(bigint, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.reserve_export_key(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.export_failed(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.export_email_intent(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.list_data_requests(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.expired_exports(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.clear_expired_export(bigint, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.erasure_export_keys(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.clear_erasure_export_keys(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.purge_expired(timestamptz) FROM PUBLIC;

RESET ROLE;

GRANT EXECUTE ON FUNCTION pii.apply_erasure_fence(bigint) TO workers;
GRANT EXECUTE ON FUNCTION pii.erasure_fence(bigint) TO workers;
GRANT EXECUTE ON FUNCTION pii.begin_erasure(bigint) TO workers;
GRANT EXECUTE ON FUNCTION pii.complete_export(bigint, text, timestamptz) TO workers;
GRANT EXECUTE ON FUNCTION pii.reserve_export_key(bigint, text) TO workers;
GRANT EXECUTE ON FUNCTION pii.export_failed(bigint, text) TO workers;
GRANT EXECUTE ON FUNCTION pii.export_email_intent(bigint) TO workers;
GRANT EXECUTE ON FUNCTION pii.list_data_requests(text, jsonb) TO staff_api;
GRANT EXECUTE ON FUNCTION pii.expired_exports(timestamptz) TO workers;
GRANT EXECUTE ON FUNCTION pii.clear_expired_export(bigint, timestamptz) TO workers;
GRANT EXECUTE ON FUNCTION pii.erasure_export_keys(bigint) TO workers;
GRANT EXECUTE ON FUNCTION pii.clear_erasure_export_keys(bigint) TO workers;
GRANT EXECUTE ON FUNCTION pii.purge_expired(timestamptz) TO workers;

-- Transactional write fence: app roles lock the member row before writing personal data, so
-- a write racing the erasure fence either commits before approval or fails after it.
SET LOCAL ROLE bulletin_owner;

CREATE OR REPLACE FUNCTION core.fence_member_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = core, pg_temp
AS $$
DECLARE
  v_member_id bigint;
  v_state text;
BEGIN
  IF current_user IN ('workers', 'pii_owner', 'bulletin_owner', 'bulletin', 'postgres') THEN
    RETURN NEW;
  END IF;

  EXECUTE format('SELECT ($1).%I', TG_ARGV[0]) INTO v_member_id USING NEW;

  IF v_member_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT state INTO v_state FROM core.members WHERE id = v_member_id FOR SHARE;

  IF v_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'member % is not active', v_member_id USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION core.fence_member_write() FROM PUBLIC;

DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('drafts', 'member_id'),
      ('posts', 'author_id'),
      ('conversation_messages', 'author_id'),
      ('conversations', 'starter_id'),
      ('conversation_participants', 'member_id'),
      ('attachments', 'member_id'),
      ('post_reactions', 'member_id'),
      ('poll_votes', 'member_id'),
      ('poll_vote_choices', 'member_id'),
      ('followed_topics', 'member_id'),
      ('followed_forums', 'member_id'),
      ('followed_members', 'follower_id'),
      ('member_ignores', 'member_id'),
      ('follow_settings', 'member_id'),
      ('member_prefs', 'member_id'),
      ('member_field_values', 'member_id'),
      ('member_restrictions', 'member_id'),
      ('api_keys', 'principal_member_id'),
      ('notifications', 'member_id'),
      ('notification_preferences', 'member_id'),
      ('digest_subscriptions', 'member_id'),
      ('delivery_intents', 'member_id'),
      ('announcement_dismissals', 'member_id'),
      ('conversation_daily_starts', 'member_id'),
      ('topic_reads', 'member_id'),
      ('forum_reads', 'member_id')
    ) AS t(table_name, column_name)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS fence_member_write ON core.%I', target.table_name);
    EXECUTE format(
      'CREATE TRIGGER fence_member_write BEFORE INSERT OR UPDATE ON core.%I
       FOR EACH ROW EXECUTE FUNCTION core.fence_member_write(%L)',
      target.table_name, target.column_name
    );
  END LOOP;
END
$$;

DROP TRIGGER IF EXISTS fence_member_write ON core.members;
CREATE TRIGGER fence_member_write
BEFORE UPDATE ON core.members
FOR EACH ROW EXECUTE FUNCTION core.fence_member_write('id');

RESET ROLE;
