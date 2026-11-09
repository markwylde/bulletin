-- 0012: any membership change marks the member's live sessions for rotation (ADR 0018).
-- Runs in the membership-change transaction and wakes the session caches.

SET LOCAL ROLE bulletin_owner;

CREATE OR REPLACE FUNCTION core.mark_member_sessions_for_rotation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
DECLARE
  v_member_id bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_member_id := OLD.member_id;
  ELSE
    v_member_id := NEW.member_id;
  END IF;

  UPDATE core.sessions
     SET rotate_pending = true
   WHERE member_id = v_member_id
     AND revoked_at IS NULL;

  PERFORM pg_notify('session_revoked', v_member_id::text);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_groups_rotate_sessions ON core.member_groups;

CREATE TRIGGER member_groups_rotate_sessions
AFTER INSERT OR UPDATE OR DELETE ON core.member_groups
FOR EACH ROW EXECUTE FUNCTION core.mark_member_sessions_for_rotation();

REVOKE ALL ON FUNCTION core.mark_member_sessions_for_rotation() FROM PUBLIC;

RESET ROLE;
