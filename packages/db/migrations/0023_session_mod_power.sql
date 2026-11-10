-- 0023: session-aware moderator check for the PII boundary (ADR 0005, 0012, 0018).
-- `core.has_mod_power` is the member-level mirror; definer functions that act for a live
-- session must use this variant so password forums also require the session's unlock grant.

SET LOCAL ROLE bulletin_owner;

CREATE OR REPLACE FUNCTION core.has_mod_power_for_session(
  p_member_id bigint,
  p_forum_id bigint,
  p_power text,
  p_session_id bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT
    core.has_mod_power(p_member_id, p_forum_id, p_power)
    AND EXISTS (
      SELECT 1
      FROM core.sessions s
      WHERE s.id = p_session_id
        AND s.member_id = p_member_id
        AND s.revoked_at IS NULL
    )
    AND (
      NOT EXISTS (
        SELECT 1
        FROM core.forums f
        WHERE f.id = p_forum_id AND f.password_hash IS NOT NULL
      )
      OR EXISTS (
        SELECT 1
        FROM core.session_grants g
        WHERE g.session_id = p_session_id
          AND g.kind = 'forum_password'
          AND g.resource_id = p_forum_id
          AND (g.expires_at IS NULL OR g.expires_at > now())
      )
    );
$$;

REVOKE ALL ON FUNCTION core.has_mod_power_for_session(bigint, bigint, text, bigint)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.has_mod_power_for_session(bigint, bigint, text, bigint)
  TO pii_owner;

RESET ROLE;
