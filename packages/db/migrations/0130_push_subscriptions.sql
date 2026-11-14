-- 0130: push subscriptions and device management (ADR 0012, 0014; task 2.1).
--
-- An endpoint (and its encryption keys) is Restricted data: app roles cannot read the table.
-- The member's own session token is the only credential accepted by the device functions, and
-- the worker receives subscriptions only through `pii.delivery_target(intent, 'push')`.

SET LOCAL ROLE bulletin_owner;

-- Push is now a per-type notification channel in addition to in-app, email and digest.
ALTER TABLE core.notification_preferences
  DROP CONSTRAINT IF EXISTS notification_preferences_channel_check;
ALTER TABLE core.notification_preferences
  ADD CONSTRAINT notification_preferences_channel_check
  CHECK (channel IN ('in_app', 'email', 'digest', 'push'));

RESET ROLE;

SET LOCAL ROLE pii_owner;

CREATE TABLE IF NOT EXISTS pii.push_subscriptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  endpoint text NOT NULL CHECK (char_length(endpoint) BETWEEN 1 AND 4096),
  p256dh text NOT NULL CHECK (char_length(p256dh) BETWEEN 1 AND 256),
  auth_secret text NOT NULL CHECK (char_length(auth_secret) BETWEEN 1 AND 128),
  label text CHECK (label IS NULL OR char_length(label) <= 80),
  browser_family text NOT NULL DEFAULT 'unknown' CHECK (char_length(browser_family) <= 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);

-- One endpoint belongs to one browser profile; a later account switch re-assigns it.
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_key
  ON pii.push_subscriptions (endpoint);

CREATE INDEX IF NOT EXISTS push_subscriptions_member_idx
  ON pii.push_subscriptions (member_id, id);

ALTER TABLE pii.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pii.push_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS push_subscriptions_owner_all ON pii.push_subscriptions;
CREATE POLICY push_subscriptions_owner_all ON pii.push_subscriptions
  FOR ALL TO pii_owner USING (true) WITH CHECK (true);

REVOKE ALL ON pii.push_subscriptions FROM PUBLIC, user_app, user_api, staff_api, workers;

-- A user-session lookup for member-owned devices. It deliberately uses the user lifetimes,
-- not the staff-only session rule (`pii.session_for_token`).
CREATE OR REPLACE FUNCTION pii.user_session_member(p_session_token text)
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
  v_member_id bigint;
  v_endpoint text := nullif(btrim(p_endpoint), '');
  v_p256dh text := nullif(btrim(p_p256dh), '');
  v_auth text := nullif(btrim(p_auth), '');
  v_label text := nullif(btrim(p_label), '');
  v_id bigint;
BEGIN
  v_member_id := pii.user_session_member(p_session_token);

  IF v_member_id IS NULL
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
    member_id, endpoint, p256dh, auth_secret, label, browser_family
  ) VALUES (
    v_member_id, v_endpoint, v_p256dh, v_auth, v_label, pii.browser_family(p_user_agent)
  )
  ON CONFLICT (endpoint) DO UPDATE
     SET member_id = EXCLUDED.member_id,
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

CREATE OR REPLACE FUNCTION pii.list_push_devices(p_session_token text)
RETURNS TABLE (
  device_id bigint,
  label text,
  browser_family text,
  created_at timestamptz,
  last_used_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
BEGIN
  v_member_id := pii.user_session_member(p_session_token);

  IF v_member_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO pii.access_log (actor_member_id, subject_member_id, purpose, resource_type)
  VALUES (v_member_id, v_member_id, 'own_data', 'push_device');

  RETURN QUERY
    SELECT s.id, s.label, s.browser_family, s.created_at, s.last_used_at
      FROM pii.push_subscriptions s
     WHERE s.member_id = v_member_id
     ORDER BY s.last_used_at DESC NULLS LAST, s.created_at DESC, s.id DESC;
END
$$;

CREATE OR REPLACE FUNCTION pii.delete_push_device(p_session_token text, p_device_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
DECLARE
  v_member_id bigint;
BEGIN
  v_member_id := pii.user_session_member(p_session_token);

  IF v_member_id IS NULL OR p_device_id IS NULL THEN
    RETURN false;
  END IF;

  DELETE FROM pii.push_subscriptions s
   WHERE s.id = p_device_id AND s.member_id = v_member_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO pii.access_log (actor_member_id, subject_member_id, purpose, resource_type)
  VALUES (v_member_id, v_member_id, 'own_data', 'push_device');

  RETURN true;
END
$$;

-- Shared by the worker's successful-send bookkeeping; never accepts an arbitrary member.
CREATE OR REPLACE FUNCTION pii.mark_push_subscription_used(
  p_intent_id bigint,
  p_subscription_id bigint
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
BEGIN
  UPDATE pii.push_subscriptions s
     SET last_used_at = now()
   WHERE s.id = p_subscription_id
     AND EXISTS (
       SELECT 1
         FROM core.delivery_intents i
         JOIN core.notifications n ON n.id = i.ref_id AND n.member_id = i.member_id
        WHERE i.id = p_intent_id
          AND i.kind = 'notification'
          AND i.channel = 'push'
          AND n.member_id = s.member_id
     );
END
$$;

CREATE OR REPLACE FUNCTION pii.delete_dead_push_subscription(
  p_intent_id bigint,
  p_subscription_id bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pii, pg_temp
AS $$
BEGIN
  DELETE FROM pii.push_subscriptions s
   WHERE s.id = p_subscription_id
     AND EXISTS (
       SELECT 1
         FROM core.delivery_intents i
         JOIN core.notifications n ON n.id = i.ref_id AND n.member_id = i.member_id
        WHERE i.id = p_intent_id
          AND i.kind = 'notification'
          AND i.channel = 'push'
          AND n.member_id = s.member_id
     );

  RETURN FOUND;
END
$$;

-- `delivery_target` gains a push branch. The return type stays text: email returns the address,
-- push returns a JSON array of the member's subscriptions (endpoint and keys never leave pii
-- through any other path).
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
    -- Push is a notification channel only; digests and system mail stay email.
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
     WHERE s.member_id = v_member_id;

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

REVOKE ALL ON FUNCTION pii.user_session_member(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.save_push_subscription(text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.list_push_devices(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.delete_push_device(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.mark_push_subscription_used(bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION pii.delete_dead_push_subscription(bigint, bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION pii.save_push_subscription(text, text, text, text, text, text) TO user_api;
GRANT EXECUTE ON FUNCTION pii.list_push_devices(text) TO user_api;
GRANT EXECUTE ON FUNCTION pii.delete_push_device(text, bigint) TO user_api;
GRANT EXECUTE ON FUNCTION pii.mark_push_subscription_used(bigint, bigint) TO workers;
GRANT EXECUTE ON FUNCTION pii.delete_dead_push_subscription(bigint, bigint) TO workers;
