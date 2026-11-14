-- 0131: bind push subscriptions to the registering session (review finding; ADR 0014, 0018).
--
-- A device is only useful while the session that registered it lives. Revoking that session
-- deletes the subscription immediately, and delivery also checks that the session is still
-- within its user lifetime so an expired session cannot keep receiving notifications.

SET LOCAL ROLE pii_owner;

ALTER TABLE pii.push_subscriptions
  ADD COLUMN IF NOT EXISTS session_id bigint REFERENCES core.sessions (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS push_subscriptions_session_idx
  ON pii.push_subscriptions (session_id);

-- The session id for a live user token; the device functions derive the member from this too.
CREATE OR REPLACE FUNCTION pii.user_session_id(p_session_token text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
  SELECT s.id
    FROM core.sessions s
   WHERE p_session_token IS NOT NULL
     AND p_session_token <> ''
     AND (
       s.token_hash = sha256(convert_to(p_session_token, 'UTF8'))
       OR (
         s.previous_token_hash = sha256(convert_to(p_session_token, 'UTF8'))
         AND s.previous_token_expires_at > now()
       )
     )
     AND s.kind = 'user'
     AND s.revoked_at IS NULL
     AND s.last_seen_at > now() - interval '30 days'
     AND s.created_at > now() - interval '90 days'
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION pii.save_push_subscription(
  p_session_token text,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_label text,
  p_user_agent text
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_session_id bigint;
  v_member_id bigint;
  v_endpoint text := nullif(btrim(p_endpoint), '');
  v_p256dh text := nullif(btrim(p_p256dh), '');
  v_auth text := nullif(btrim(p_auth), '');
  v_label text := nullif(btrim(p_label), '');
  v_id bigint;
BEGIN
  v_session_id := pii.user_session_id(p_session_token);
  v_member_id := pii.user_session_member(p_session_token);

  IF v_session_id IS NULL
     OR v_member_id IS NULL
     OR v_endpoint IS NULL
     OR v_p256dh IS NULL
     OR v_auth IS NULL
     OR char_length(v_endpoint) > 4096
     OR char_length(v_p256dh) > 256
     OR char_length(v_auth) > 128
  THEN
    RETURN NULL;
  END IF;

  INSERT INTO pii.push_subscriptions (
    member_id, session_id, endpoint, p256dh, auth_secret, label, browser_family
  ) VALUES (
    v_member_id, v_session_id, v_endpoint, v_p256dh, v_auth, v_label,
    pii.browser_family(p_user_agent)
  )
  ON CONFLICT (endpoint) DO UPDATE
     SET member_id = EXCLUDED.member_id,
         session_id = EXCLUDED.session_id,
         p256dh = EXCLUDED.p256dh,
         auth_secret = EXCLUDED.auth_secret,
         label = EXCLUDED.label,
         browser_family = EXCLUDED.browser_family,
         updated_at = now()
  RETURNING id INTO v_id;

  INSERT INTO pii.access_log (actor_member_id, subject_member_id, purpose, resource_type)
  VALUES (v_member_id, v_member_id, 'own_data', 'push_subscription');

  RETURN v_id;
END
$$;

-- Revocation is a write in core.sessions, so delete the device rows in that same transaction.
CREATE OR REPLACE FUNCTION pii.delete_revoked_session_push_subscriptions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL
     AND (OLD.revoked_at IS NULL OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at)
  THEN
    DELETE FROM pii.push_subscriptions WHERE session_id = NEW.id;
  END IF;

  RETURN NEW;
END
$$;

-- The trigger lives on a core table, which only its owner may alter; the function itself runs
-- as pii_owner so it can delete the restricted subscription rows.
GRANT USAGE ON SCHEMA pii TO bulletin_owner;
GRANT EXECUTE ON FUNCTION pii.delete_revoked_session_push_subscriptions() TO bulletin_owner;

RESET ROLE;

SET LOCAL ROLE bulletin_owner;

DROP TRIGGER IF EXISTS sessions_revoke_push_subscriptions ON core.sessions;
CREATE TRIGGER sessions_revoke_push_subscriptions
  AFTER UPDATE OF revoked_at ON core.sessions
  FOR EACH ROW
  EXECUTE FUNCTION pii.delete_revoked_session_push_subscriptions();

RESET ROLE;

SET LOCAL ROLE pii_owner;

-- Delivery refuses a subscription whose session has ended, even if cleanup was missed.
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
  v_push text;
BEGIN
  IF p_channel NOT IN ('email', 'push') THEN
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
       WHERE p.member_id = v_member_id AND p.type = v_type AND p.channel = p_channel
    ), CASE WHEN p_channel = 'email' THEN true ELSE false END)
    INTO v_enabled;

    IF v_enabled IS NOT TRUE THEN
      RETURN NULL;
    END IF;
  ELSIF v_kind = 'digest' THEN
    IF p_channel <> 'email' THEN
      RETURN NULL;
    END IF;

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

  IF p_channel = 'push' THEN
    IF v_kind <> 'notification' THEN
      RETURN NULL;
    END IF;

    SELECT coalesce(
             json_agg(
               json_build_object(
                 'id', s.id,
                 'endpoint', s.endpoint,
                 'p256dh', s.p256dh,
                 'auth', s.auth_secret
               ) ORDER BY s.id
             ),
             '[]'::json
           )::text
      INTO v_push
      FROM pii.push_subscriptions s
      JOIN core.sessions sess ON sess.id = s.session_id
     WHERE s.member_id = v_member_id
       AND sess.revoked_at IS NULL
       AND sess.kind = 'user'
       AND sess.last_seen_at > now() - interval '30 days'
       AND sess.created_at > now() - interval '90 days';

    INSERT INTO pii.access_log (
      actor_member_id, subject_member_id, purpose, resource_type, resource_id
    ) VALUES (
      NULL, v_member_id, 'delivery', 'delivery_intent', p_intent_id::text
    );

    RETURN v_push;
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

REVOKE ALL ON FUNCTION pii.user_session_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.delete_revoked_session_push_subscriptions() FROM PUBLIC;
