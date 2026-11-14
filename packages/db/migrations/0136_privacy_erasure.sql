-- 0136: erasure fence, restricted-data deletion and the ordered erasure job support
-- (ADR 0012; privacy-gdpr tasks 4.1-4.4).

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.notifications
  ALTER COLUMN data_request_id TYPE bigint;

-- "Deleted member #<id>" can be longer than an ordinary display name.
ALTER TABLE core.members DROP CONSTRAINT IF EXISTS members_display_name_length_check;
ALTER TABLE core.members
  ADD CONSTRAINT members_display_name_length_check
  CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 3 AND 64);

RESET ROLE;

-- The fence runs inside the approval transaction. It needs to revoke credentials and append
-- the accepted event; the erasure job then needs to read the fence IDs for the journal.
GRANT UPDATE, DELETE ON core.members, core.sessions TO pii_owner;
GRANT SELECT, UPDATE ON core.api_keys TO pii_owner;
GRANT INSERT ON core.events TO pii_owner;
GRANT USAGE, SELECT ON SEQUENCE core.events_id_seq TO pii_owner;

-- The erasure job runs as `workers`; these are the rows it must remove or anonymise. All are
-- the member's own content/settings, never another member's content.
GRANT SELECT, DELETE ON
  core.notification_actors,
  core.notification_events,
  core.notification_preferences,
  core.digest_subscriptions,
  core.digest_deliveries,
  core.delivery_intents,
  core.member_field_values,
  core.member_prefs,
  core.follow_settings,
  core.followed_topics,
  core.followed_forums,
  core.followed_members,
  core.friendships,
  core.member_ignores,
  core.drafts,
  core.post_revisions,
  core.poll_vote_choices,
  core.poll_votes,
  core.post_reactions,
  core.leaderboard_entries,
  core.topic_reads,
  core.forum_reads,
  core.announcement_dismissals,
  core.conversation_daily_starts,
  core.member_restrictions,
  core.member_storage,
  core.moderators,
  core.api_keys,
  core.slug_history
TO workers;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.notifications TO workers;
GRANT SELECT, UPDATE, DELETE ON core.member_badges TO workers;
GRANT UPDATE, DELETE ON core.posts TO workers;
GRANT UPDATE ON core.topics, core.forums, core.reports TO workers;
GRANT DELETE ON core.report_reporters, core.report_comments TO workers;

SET LOCAL ROLE pii_owner;

ALTER TABLE pii.data_requests
  ADD COLUMN IF NOT EXISTS post_action text NOT NULL DEFAULT 'anonymise'
    CHECK (post_action IN ('anonymise', 'delete'));

COMMENT ON COLUMN pii.data_requests.post_action
  IS '@personal class=restricted';

CREATE TABLE IF NOT EXISTS pii.erasure_fences (
  request_id bigint PRIMARY KEY REFERENCES pii.data_requests (id) ON DELETE CASCADE,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  session_ids bigint[] NOT NULL DEFAULT '{}',
  api_key_ids bigint[] NOT NULL DEFAULT '{}',
  push_device_ids bigint[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pii.erasure_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii.erasure_fences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS erasure_fences_owner_all ON pii.erasure_fences;
CREATE POLICY erasure_fences_owner_all ON pii.erasure_fences
  FOR ALL TO pii_owner USING (true) WITH CHECK (true);

REVOKE ALL ON pii.erasure_fences FROM PUBLIC, user_app, user_api, staff_api, workers;

COMMENT ON COLUMN pii.erasure_fences.request_id IS '@personal class=restricted';
COMMENT ON COLUMN pii.erasure_fences.member_id IS '@personal class=restricted';
COMMENT ON COLUMN pii.erasure_fences.session_ids IS '@personal class=restricted';
COMMENT ON COLUMN pii.erasure_fences.api_key_ids IS '@personal class=restricted';
COMMENT ON COLUMN pii.erasure_fences.push_device_ids IS '@personal class=restricted';
COMMENT ON COLUMN pii.erasure_fences.created_at IS '@personal class=restricted';

-- One fence for approval and for a retried job. Re-running it returns the first revocation
-- set, so the journal never loses IDs after a crash.
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
BEGIN
  SELECT r.member_id, r.status INTO v_member_id, v_status
    FROM pii.data_requests r
   WHERE r.id = p_request_id AND r.kind = 'erasure'
   FOR UPDATE;

  IF NOT FOUND OR v_status NOT IN ('pending', 'processing') THEN
    RETURN;
  END IF;

  UPDATE core.members
     SET state = 'erasing'
   WHERE id = v_member_id
     AND state = 'active';

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

  INSERT INTO pii.erasure_fences (request_id, member_id, session_ids, api_key_ids, push_device_ids)
  VALUES (p_request_id, v_member_id, v_sessions, v_keys, v_devices)
  ON CONFLICT (request_id) DO NOTHING;

  RETURN QUERY
    SELECT f.member_id, f.session_ids, f.api_key_ids, f.push_device_ids
      FROM pii.erasure_fences f
     WHERE f.request_id = p_request_id;
END;
$$;

-- The erasure queue reads the fence IDs for the journal.
CREATE OR REPLACE FUNCTION pii.erasure_fence(p_request_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
  SELECT jsonb_build_object(
    'memberId', f.member_id::text,
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

  UPDATE pii.data_requests
     SET status = 'processing', updated_at = now()
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
    'sessionIds', to_jsonb(v_fence.session_ids::text[]),
    'apiKeyIds', to_jsonb(v_fence.api_key_ids::text[]),
    'pushDeviceIds', to_jsonb(v_fence.push_device_ids)
  );
END;
$$;

CREATE OR REPLACE FUNCTION pii.request_step_states(p_request_id bigint)
RETURNS TABLE (step text, state text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
  SELECT s.step, s.state
  FROM pii.data_request_steps s
  WHERE s.request_id = p_request_id
$$;

CREATE OR REPLACE FUNCTION pii.complete_erasure(p_request_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
BEGIN
  UPDATE pii.data_requests
     SET status = 'completed',
         completed_at = now(),
         updated_at = now()
   WHERE id = p_request_id
     AND kind = 'erasure'
     AND status = 'processing';

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  )
  SELECT NULL, r.member_id, 'erasure', 'data_request', p_request_id::text
    FROM pii.data_requests r
   WHERE r.id = p_request_id;

  RETURN true;
END;
$$;

-- Removes every restricted record for the request's member and returns the archive keys the
-- worker must delete. Access-log rows and the request rows themselves are retained (ADR 0012).
CREATE OR REPLACE FUNCTION pii.erase_restricted_data(p_request_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
  v_keys text[];
  v_identities bigint;
  v_ip_logs bigint;
  v_post_ips bigint;
  v_sessions bigint;
  v_grants bigint;
BEGIN
  SELECT member_id INTO v_member_id
    FROM pii.data_requests
   WHERE id = p_request_id AND kind = 'erasure';

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(array_agg(export_key), '{}'::text[]) INTO v_keys
    FROM pii.data_requests
   WHERE member_id = v_member_id
     AND export_key IS NOT NULL;

  UPDATE pii.data_requests
     SET export_key = NULL, export_expires_at = NULL, updated_at = now()
   WHERE member_id = v_member_id
     AND export_key IS NOT NULL;

  DELETE FROM pii.identities WHERE member_id = v_member_id;
  GET DIAGNOSTICS v_identities = ROW_COUNT;

  DELETE FROM pii.ip_log WHERE member_id = v_member_id;
  GET DIAGNOSTICS v_ip_logs = ROW_COUNT;

  DELETE FROM pii.post_ips WHERE member_id = v_member_id;
  GET DIAGNOSTICS v_post_ips = ROW_COUNT;

  DELETE FROM pii.access_grants
   WHERE actor_member_id = v_member_id OR subject_member_id = v_member_id;
  GET DIAGNOSTICS v_grants = ROW_COUNT;

  DELETE FROM core.sessions WHERE member_id = v_member_id;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  ) VALUES (
    NULL, v_member_id, 'erasure', 'data_request', p_request_id::text
  );

  RETURN jsonb_build_object(
    'memberId', v_member_id::text,
    'exportKeys', to_jsonb(v_keys),
    'identities', v_identities,
    'ipLogs', v_ip_logs,
    'postIps', v_post_ips,
    'accessGrants', v_grants,
    'sessions', v_sessions
  );
END;
$$;

-- Staff approval and erasure requests. The fence commits with the request status change and
-- the `privacy.erasure.accepted` outbox event, so no worker can start before it is durable.
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

  IF p_action IS NULL OR p_action NOT IN ('process', 'complete', 'reject') THEN
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

-- Login and first-login are refused once erasure starts. Returning NULL also stops email/name
-- updates from recreating identity data.
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
  v_issuer text := p_issuer;
  v_sub text := p_sub;
  v_email text := nullif(btrim(p_email), '');
  v_name text := nullif(btrim(p_name), '');
  v_member_id bigint;
  v_stored_email text;
  v_stored_name text;
  v_state text;
BEGIN
  IF v_issuer IS NULL OR btrim(v_issuer) = '' OR v_sub IS NULL OR btrim(v_sub) = '' THEN
    RAISE EXCEPTION 'issuer and subject are required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_issuer || E'\x1f' || v_sub, 0));

  SELECT member_id, email, idp_name
    INTO v_member_id, v_stored_email, v_stored_name
    FROM pii.identities
   WHERE issuer = v_issuer AND sub = v_sub;

  IF FOUND THEN
    SELECT state INTO v_state FROM core.members WHERE id = v_member_id;

    IF v_state IS DISTINCT FROM 'active' THEN
      RETURN NULL;
    END IF;

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

-- An export that was queued before the erasure fence must not rebuild personal data.
CREATE OR REPLACE FUNCTION pii.begin_export(p_request_id bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
  v_state text;
BEGIN
  SELECT r.member_id INTO v_member_id
    FROM pii.data_requests r
   WHERE r.id = p_request_id
     AND r.kind = 'export'
     AND r.status IN ('pending', 'processing');

  IF v_member_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT state INTO v_state FROM core.members WHERE id = v_member_id;

  IF v_state IS DISTINCT FROM 'active' THEN
    RETURN NULL;
  END IF;

  UPDATE pii.data_requests
     SET status = 'processing', updated_at = now()
   WHERE id = p_request_id
     AND kind = 'export'
     AND status IN ('pending', 'processing');

  IF NOT FOUND THEN
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

REVOKE ALL ON FUNCTION pii.apply_erasure_fence(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.erasure_fence(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.begin_erasure(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.complete_erasure(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.request_step_states(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.erase_restricted_data(bigint) FROM PUBLIC;

RESET ROLE;

GRANT EXECUTE ON FUNCTION pii.apply_erasure_fence(bigint) TO workers;
GRANT EXECUTE ON FUNCTION pii.erasure_fence(bigint) TO workers;
GRANT EXECUTE ON FUNCTION pii.begin_erasure(bigint) TO workers;
GRANT EXECUTE ON FUNCTION pii.complete_erasure(bigint) TO workers;
GRANT EXECUTE ON FUNCTION pii.request_step_states(bigint) TO workers;
GRANT EXECUTE ON FUNCTION pii.erase_restricted_data(bigint) TO workers;

-- An erased or erasing member no longer needs a primary group; the erasure job removes every
-- membership after the fence commits.
SET LOCAL ROLE bulletin_owner;

CREATE OR REPLACE FUNCTION core.assert_member_has_one_primary_group()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_member_id bigint;
  v_primaries integer;
  v_state text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_member_id := OLD.member_id;
  ELSE
    v_member_id := NEW.member_id;
  END IF;

  SELECT state INTO v_state FROM core.members WHERE id = v_member_id;

  IF NOT FOUND OR v_state IS DISTINCT FROM 'active' THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_primaries
  FROM core.member_groups
  WHERE member_id = v_member_id
    AND is_primary;

  IF v_primaries <> 1 THEN
    RAISE EXCEPTION 'member % must have exactly one primary group (found %)',
      v_member_id, v_primaries
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION core.assert_member_has_one_primary_group() FROM PUBLIC;

RESET ROLE;
