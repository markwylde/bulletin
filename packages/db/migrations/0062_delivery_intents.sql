-- 0062: delivery intents and the workers-only delivery target (ADR 0012, 0011).
--
-- Every outbound message is recorded before it is sent. `pii.delivery_target` returns the
-- recipient's address only for an undelivered intent whose notification still has email
-- enabled, and writes one access-log row per call. Workers never read `pii` tables directly.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.delivery_intents (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('notification', 'digest', 'system')),
  ref_id bigint NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'push')),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CONSTRAINT delivery_intents_unique UNIQUE (kind, ref_id, channel)
);

CREATE INDEX IF NOT EXISTS delivery_intents_pending_idx
  ON core.delivery_intents (created_at)
  WHERE delivered_at IS NULL;

RESET ROLE;

GRANT SELECT, INSERT, UPDATE ON core.delivery_intents TO workers;
GRANT USAGE, SELECT ON core.delivery_intents_id_seq TO workers;

-- Workers reach `pii` only through the function below (ADR 0012); executing it needs schema
-- usage, not table access.
GRANT USAGE ON SCHEMA pii TO workers;

GRANT SELECT ON core.delivery_intents, core.notifications, core.notification_preferences
  TO pii_owner;

SET LOCAL ROLE pii_owner;

CREATE OR REPLACE FUNCTION pii.delivery_target(p_intent_id bigint, p_channel text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
  v_kind text;
  v_ref_id bigint;
  v_type text;
  v_enabled boolean;
  v_email text;
BEGIN
  IF p_channel <> 'email' THEN
    RETURN NULL;
  END IF;

  SELECT member_id, kind, ref_id
    INTO v_member_id, v_kind, v_ref_id
    FROM core.delivery_intents
   WHERE id = p_intent_id AND delivered_at IS NULL;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_kind = 'notification' THEN
    SELECT type INTO v_type
      FROM core.notifications
     WHERE id = v_ref_id AND member_id = v_member_id;

    IF NOT FOUND THEN
      RETURN NULL;
    END IF;

    SELECT coalesce((
      SELECT p.enabled
        FROM core.notification_preferences p
       WHERE p.member_id = v_member_id AND p.type = v_type AND p.channel = 'email'
    ), true)
    INTO v_enabled;

    IF v_enabled IS NOT TRUE THEN
      RETURN NULL;
    END IF;
  ELSIF v_kind = 'digest' THEN
    PERFORM 1
      FROM core.digest_deliveries d
      JOIN core.digest_subscriptions s ON s.member_id = d.member_id
     WHERE d.id = v_ref_id
       AND d.member_id = v_member_id
       AND s.frequency <> 'off';

    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT email INTO v_email
    FROM pii.identities
   WHERE member_id = v_member_id;

  IF v_email IS NULL OR btrim(v_email) = '' THEN
    RETURN NULL;
  END IF;

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type, resource_id
  ) VALUES (
    NULL, v_member_id, 'delivery', 'delivery_intent', p_intent_id::text
  );

  RETURN v_email;
END
$$;

RESET ROLE;

REVOKE ALL ON FUNCTION pii.delivery_target(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pii.delivery_target(bigint, text) TO workers;
