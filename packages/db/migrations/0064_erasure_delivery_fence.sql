-- 0064: erasure fence for delivery and system mail (ADR 0012, task 6.1).
--
-- `core.members.state` is the erasure fence: the privacy change drives it, but delivery must
-- already refuse a member whose erasure was accepted. System mail bypasses notification
-- preferences (it cannot be disabled) but still respects the fence and the missing-address case.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'active';

ALTER TABLE core.members
  DROP CONSTRAINT IF EXISTS members_state_check;

ALTER TABLE core.members
  ADD CONSTRAINT members_state_check CHECK (state IN ('active', 'erasing', 'erased'));

RESET ROLE;

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
  v_state text;
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

  SELECT state INTO v_state FROM core.members WHERE id = v_member_id;

  IF v_state IS DISTINCT FROM 'active' THEN
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
  ELSIF v_kind <> 'system' THEN
    RETURN NULL;
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
