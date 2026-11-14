-- 0143: revocations in the restore journal (ADR 0020, ADR 0012, ADR 0011).
--
-- A database restore must not bring back a session or API key that was revoked, or a push
-- device that was removed, after the restore point. Triggers record every such change, whatever
-- code path made it, in core.revocation_journal_pending (IDs only). Workers drain the rows into
-- journal entries in object storage, outside the database rollback set, and the post-restore
-- replay applies them again through pii.replay_revocations before any service reports ready.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.revocation_journal_pending (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('session', 'api_key', 'push_device')),
  target_id bigint NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE core.revocation_journal_pending
  IS 'Revoked sessions/API keys and removed push devices not yet journalled; IDs only';

-- UPDATE only for the row locks the drain takes (SELECT … FOR UPDATE SKIP LOCKED).
GRANT SELECT, UPDATE, DELETE ON core.revocation_journal_pending TO workers;
GRANT INSERT ON core.revocation_journal_pending TO pii_owner;

-- Revocation entries share the applied-keys table; they carry no request.
ALTER TABLE core.erasure_journal_applied
  DROP CONSTRAINT IF EXISTS erasure_journal_applied_key_check;
ALTER TABLE core.erasure_journal_applied
  ADD CONSTRAINT erasure_journal_applied_key_check
  CHECK (key ~ '^journal/\d{4}-\d{2}-\d{2}/(\d{12}|rev-\d{13}-\d{12})\.json$');
ALTER TABLE core.erasure_journal_applied ALTER COLUMN request_id DROP NOT NULL;

-- Entries older than the 35-day recovery window are pruned with their applied rows.
GRANT DELETE ON core.erasure_journal_applied TO workers;

CREATE OR REPLACE FUNCTION core.journal_revocation() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
BEGIN
  INSERT INTO core.revocation_journal_pending (kind, target_id) VALUES (TG_ARGV[0], OLD.id);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION core.journal_revocation() FROM PUBLIC;

DROP TRIGGER IF EXISTS sessions_journal_revoked ON core.sessions;
CREATE TRIGGER sessions_journal_revoked
  AFTER UPDATE OF revoked_at ON core.sessions
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION core.journal_revocation('session');

DROP TRIGGER IF EXISTS sessions_journal_deleted ON core.sessions;
CREATE TRIGGER sessions_journal_deleted
  AFTER DELETE ON core.sessions
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL)
  EXECUTE FUNCTION core.journal_revocation('session');

DROP TRIGGER IF EXISTS api_keys_journal_revoked ON core.api_keys;
CREATE TRIGGER api_keys_journal_revoked
  AFTER UPDATE OF revoked_at ON core.api_keys
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION core.journal_revocation('api_key');

DROP TRIGGER IF EXISTS api_keys_journal_deleted ON core.api_keys;
CREATE TRIGGER api_keys_journal_deleted
  AFTER DELETE ON core.api_keys
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL)
  EXECUTE FUNCTION core.journal_revocation('api_key');

SET LOCAL ROLE pii_owner;

-- A removed device, or an endpoint re-assigned to another member, must not come back to the
-- previous owner through a restore: the replay removes the subscription and the browser
-- subscribes again.
CREATE OR REPLACE FUNCTION pii.journal_push_device_removal() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
BEGIN
  INSERT INTO core.revocation_journal_pending (kind, target_id) VALUES ('push_device', OLD.id);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION pii.journal_push_device_removal() FROM PUBLIC;

DROP TRIGGER IF EXISTS push_subscriptions_journal_deleted ON pii.push_subscriptions;
CREATE TRIGGER push_subscriptions_journal_deleted
  AFTER DELETE ON pii.push_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION pii.journal_push_device_removal();

DROP TRIGGER IF EXISTS push_subscriptions_journal_reassigned ON pii.push_subscriptions;
CREATE TRIGGER push_subscriptions_journal_reassigned
  AFTER UPDATE OF member_id ON pii.push_subscriptions
  FOR EACH ROW WHEN (OLD.member_id IS DISTINCT FROM NEW.member_id)
  EXECUTE FUNCTION pii.journal_push_device_removal();

-- Re-applies one journalled batch of revocations after a restore. IDs only; rows that are
-- already revoked, or that postdate the restore point, are left alone.
CREATE OR REPLACE FUNCTION pii.replay_revocations(
  p_session_ids bigint[],
  p_api_key_ids bigint[],
  p_push_device_ids bigint[]
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_sessions integer;
  v_api_keys integer;
  v_devices integer;
BEGIN
  UPDATE core.sessions
     SET revoked_at = now()
   WHERE id = ANY(p_session_ids) AND revoked_at IS NULL;
  GET DIAGNOSTICS v_sessions = ROW_COUNT;

  UPDATE core.api_keys
     SET revoked_at = now()
   WHERE id = ANY(p_api_key_ids) AND revoked_at IS NULL;
  GET DIAGNOSTICS v_api_keys = ROW_COUNT;

  WITH removed AS (
    DELETE FROM pii.push_subscriptions
     WHERE id = ANY(p_push_device_ids)
    RETURNING member_id
  ), audited AS (
    INSERT INTO pii.access_log (
      actor_member_id, subject_member_id, purpose, resource_type
    )
    SELECT DISTINCT NULL::bigint, member_id, 'revocation_replay', 'push_subscription'
      FROM removed
    RETURNING 1
  )
  SELECT count(*) INTO v_devices FROM removed;

  RETURN jsonb_build_object(
    'sessions', v_sessions, 'apiKeys', v_api_keys, 'pushDevices', v_devices
  );
END;
$$;

REVOKE ALL ON FUNCTION pii.replay_revocations(bigint[], bigint[], bigint[]) FROM PUBLIC;

RESET ROLE;

GRANT EXECUTE ON FUNCTION pii.replay_revocations(bigint[], bigint[], bigint[]) TO workers;
