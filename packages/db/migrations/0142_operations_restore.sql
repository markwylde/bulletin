-- 0142: restore support (ADR 0020, ADR 0012; operations-observability tasks 4.2 and 4.4).
--
-- * core.erasure_journal_applied records which erasure journal entries (object storage, outside
--   the database rollback set) this database has applied. After a restore, entries newer than
--   the restore point are missing here and are replayed before any service reports ready.
-- * core.missing_objects lists rows whose stored object no longer exists, for the staff app and
--   for a clear download error.
-- * core.restore_runs records each post-restore run (replay, reconciliation, scan).

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.erasure_journal_applied (
  key text PRIMARY KEY CHECK (key ~ '^journal/\d{4}-\d{2}-\d{2}/\d{12}\.json$'),
  request_id bigint NOT NULL,
  replayed boolean NOT NULL DEFAULT false,
  applied_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE core.erasure_journal_applied
  IS 'Erasure journal keys applied to this database; IDs only, never personal data';

CREATE TABLE IF NOT EXISTS core.missing_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('attachment', 'avatar')),
  -- The attachment ID, or the member ID for an avatar.
  resource_id bigint NOT NULL,
  storage_key text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, storage_key)
);

CREATE INDEX IF NOT EXISTS missing_objects_resource_idx
  ON core.missing_objects (kind, resource_id);

COMMENT ON COLUMN core.missing_objects.resource_id IS '@personal class=derived';
COMMENT ON COLUMN core.missing_objects.storage_key IS '@personal class=derived';

CREATE TABLE IF NOT EXISTS core.restore_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger text NOT NULL CHECK (trigger IN ('detected', 'manual')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  replayed integer NOT NULL DEFAULT 0,
  removed_objects integer NOT NULL DEFAULT 0,
  missing_objects integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed'))
);

RESET ROLE;

GRANT SELECT, INSERT, UPDATE ON core.erasure_journal_applied TO workers;
GRANT SELECT ON core.erasure_journal_applied TO user_app, user_api, staff_api;
GRANT SELECT, INSERT, DELETE ON core.missing_objects TO workers;
GRANT SELECT ON core.missing_objects TO user_app, staff_api;
GRANT SELECT, INSERT, UPDATE ON core.restore_runs TO workers;
GRANT SELECT ON core.restore_runs TO staff_api;
-- Restore detection compares the outbox sequence with the watermark in object storage.
GRANT SELECT ON SEQUENCE core.events_id_seq TO workers;

SET LOCAL ROLE pii_owner;

-- Re-applies one journalled erasure after a restore. The journal holds IDs only; the request
-- row is recreated when the restore point predates it, credentials and push devices named in
-- the journal are revoked again, and the fence is reapplied so the ordinary erasure job can
-- run. Returns the request to run, or a status when there is nothing to do.
CREATE OR REPLACE FUNCTION pii.replay_erasure(
  p_request_id bigint,
  p_member_id bigint,
  p_post_action text,
  p_session_ids bigint[],
  p_api_key_ids bigint[],
  p_push_device_ids bigint[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_request_id bigint := p_request_id;
  v_status text;
  v_member bigint;
  v_post_action text := CASE WHEN p_post_action = 'delete' THEN 'delete' ELSE 'anonymise' END;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.members WHERE id = p_member_id) THEN
    -- The member joined after the restore point: nothing of theirs was restored.
    RETURN jsonb_build_object('status', 'no_member');
  END IF;

  SELECT r.status, r.member_id INTO v_status, v_member
    FROM pii.data_requests r
   WHERE r.id = p_request_id AND r.kind = 'erasure'
   FOR UPDATE;

  IF FOUND AND v_member IS DISTINCT FROM p_member_id THEN
    RAISE EXCEPTION 'journal request % does not belong to member %', p_request_id, p_member_id
      USING ERRCODE = '22023';
  END IF;

  IF FOUND AND v_status = 'completed' THEN
    RETURN jsonb_build_object('status', 'already', 'requestId', p_request_id::text);
  END IF;

  IF NOT FOUND THEN
    -- An open request for the member may exist under another ID (one open request per kind).
    SELECT r.id INTO v_request_id
      FROM pii.data_requests r
     WHERE r.member_id = p_member_id AND r.kind = 'erasure'
       AND r.status IN ('pending', 'processing')
     FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO pii.data_requests (id, member_id, kind, status, post_action, reason)
      OVERRIDING SYSTEM VALUE
      VALUES (p_request_id, p_member_id, 'erasure', 'processing', v_post_action,
              'Replayed from the erasure journal after a restore')
      RETURNING id INTO v_request_id;

      PERFORM setval(
        pg_get_serial_sequence('pii.data_requests', 'id'),
        GREATEST((SELECT max(id) FROM pii.data_requests), 1)
      );
    END IF;
  END IF;

  UPDATE pii.data_requests
     SET status = 'processing', post_action = v_post_action, updated_at = now(),
         completed_at = NULL
   WHERE id = v_request_id;

  UPDATE core.sessions
     SET revoked_at = COALESCE(revoked_at, now())
   WHERE id = ANY(p_session_ids) OR member_id = p_member_id;

  UPDATE core.api_keys
     SET revoked_at = COALESCE(revoked_at, now())
   WHERE id = ANY(p_api_key_ids) OR principal_member_id = p_member_id;

  DELETE FROM pii.push_subscriptions
   WHERE id = ANY(p_push_device_ids) OR member_id = p_member_id;

  PERFORM pii.apply_erasure_fence(v_request_id);

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  ) VALUES (
    NULL, p_member_id, 'erasure_replay', 'data_request', v_request_id::text
  );

  RETURN jsonb_build_object('status', 'replay', 'requestId', v_request_id::text);
END;
$$;

REVOKE ALL ON FUNCTION pii.replay_erasure(bigint, bigint, text, bigint[], bigint[], bigint[])
  FROM PUBLIC;

RESET ROLE;

GRANT EXECUTE ON FUNCTION pii.replay_erasure(bigint, bigint, text, bigint[], bigint[], bigint[])
  TO workers;
