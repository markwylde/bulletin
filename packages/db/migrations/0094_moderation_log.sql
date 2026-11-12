-- 0094: moderation log scope and filters (moderation 7.1; ADR 0006, 0012).
--
-- The log is append-only for every application role: INSERT and SELECT only, no UPDATE or
-- DELETE. Scope columns make forum-moderator filtering an indexed SQL condition.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.moderation_log
  ADD COLUMN IF NOT EXISTS forum_id bigint REFERENCES core.forums (id) ON DELETE SET NULL;
ALTER TABLE core.moderation_log
  ADD COLUMN IF NOT EXISTS member_id bigint REFERENCES core.members (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS moderation_log_forum_created_idx
  ON core.moderation_log (forum_id, created_at DESC, id DESC)
  WHERE forum_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS moderation_log_member_created_idx
  ON core.moderation_log (member_id, created_at DESC, id DESC)
  WHERE member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS moderation_log_action_created_idx
  ON core.moderation_log (action, created_at DESC, id DESC);

-- Forum moderators render their scoped log through the user app's read role.
GRANT SELECT ON core.moderation_log TO user_app;

RESET ROLE;
