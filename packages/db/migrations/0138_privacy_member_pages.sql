-- 0138: admin-managed privacy policy and the member's own request status
-- (ADR 0012; privacy-gdpr task 6.1).

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.privacy_settings
  ADD COLUMN IF NOT EXISTS policy_md text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS policy_html text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS policy_text text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS policy_render_version integer NOT NULL DEFAULT 3_000_000,
  ADD COLUMN IF NOT EXISTS policy_sanitiser_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS policy_updated_at timestamptz;

ALTER TABLE core.privacy_settings
  DROP CONSTRAINT IF EXISTS privacy_settings_policy_render_version_check;
ALTER TABLE core.privacy_settings
  ADD CONSTRAINT privacy_settings_policy_render_version_check
  CHECK (policy_render_version > 0);

ALTER TABLE core.privacy_settings
  DROP CONSTRAINT IF EXISTS privacy_settings_policy_sanitiser_version_check;
ALTER TABLE core.privacy_settings
  ADD CONSTRAINT privacy_settings_policy_sanitiser_version_check
  CHECK (policy_sanitiser_version > 0);

RESET ROLE;

-- The public policy page is rendered by user-app; the member request list comes from user-api.
GRANT SELECT ON core.privacy_settings TO user_app;
GRANT INSERT, UPDATE ON core.privacy_settings TO staff_api;

SET LOCAL ROLE pii_owner;

CREATE OR REPLACE FUNCTION pii.own_data_requests(p_session_token text)
RETURNS TABLE (
  id bigint,
  kind text,
  status text,
  created_at timestamptz,
  due_at timestamptz,
  completed_at timestamptz,
  export_expires_at timestamptz
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

  INSERT INTO pii.access_log (
    actor_member_id, subject_member_id, purpose, resource_type
  ) VALUES (
    v_member_id, v_member_id, 'own_data', 'data_request'
  );

  RETURN QUERY
    SELECT r.id, r.kind, r.status, r.created_at, r.due_at, r.completed_at,
      r.export_expires_at
      FROM pii.data_requests r
     WHERE r.member_id = v_member_id
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT 50;
END;
$$;

REVOKE ALL ON FUNCTION pii.own_data_requests(text) FROM PUBLIC;

RESET ROLE;

GRANT EXECUTE ON FUNCTION pii.own_data_requests(text) TO user_api;
