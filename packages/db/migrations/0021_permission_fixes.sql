-- 0021: permission-review fixes (ADR 0005, 0012, 0018).
-- 1. `core.has_mod_power` now applies the mask matrix and ancestor visibility, so PII
--    definer functions cannot grant moderator powers on forums the member cannot read.
-- 2. Password throttling persists its lockout deadline instead of deriving it from the oldest
--    of five failures.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.forum_unlock_lockouts (
  session_id bigint NOT NULL REFERENCES core.sessions (id) ON DELETE CASCADE,
  forum_id bigint NOT NULL REFERENCES core.forums (id) ON DELETE CASCADE,
  locked_until timestamptz NOT NULL,
  PRIMARY KEY (session_id, forum_id)
);

-- Resolves one mask's actions for a forum through the inheritance chain, with read implying show.
CREATE OR REPLACE FUNCTION core.forum_mask_actions(p_forum_id bigint, p_mask_id bigint)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  WITH RECURSIVE up AS (
    SELECT f.id, f.parent_id, 0 AS depth
    FROM core.forums f
    WHERE f.id = p_forum_id

    UNION ALL

    SELECT parent.id, parent.parent_id, up.depth + 1
    FROM core.forums parent
    JOIN up ON parent.id = up.parent_id
  ),
  chain AS (
    SELECT id, (SELECT max(depth) FROM up) - depth AS level
    FROM up
  ),
  resolved AS (
    SELECT
      c.id,
      c.level,
      COALESCE(fp.actions, 0) AS actions,
      COALESCE(fp.inherits, true) AS inherits,
      (fp.forum_id IS NULL) AS missing
    FROM chain c
    LEFT JOIN core.forum_permissions fp
      ON fp.forum_id = c.id AND fp.mask_id = p_mask_id
  ),
  folded AS (
    SELECT id, level, actions AS value
    FROM resolved
    WHERE level = 0

    UNION ALL

    SELECT
      r.id,
      r.level,
      CASE WHEN r.missing OR r.inherits THEN f.value ELSE r.actions END
    FROM resolved r
    JOIN folded f ON r.level = f.level + 1
  )
  SELECT CASE WHEN value & 2 <> 0 THEN value | 1 ELSE value END
  FROM folded
  WHERE level = (SELECT max(level) FROM resolved);
$$;

REVOKE ALL ON FUNCTION core.forum_mask_actions(bigint, bigint) FROM PUBLIC;

-- The base mask read bit plus the ancestor show rule (ADR 0005). Password unlocks are a
-- session condition and are not part of this member-level check.
CREATE OR REPLACE FUNCTION core.can_read_forum(p_member_id bigint, p_forum_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  WITH lineage AS (
    SELECT id FROM core.forum_lineage(p_forum_id)
  ),
  masks AS (
    SELECT DISTINCT gm.mask_id
    FROM core.member_groups mg
    JOIN core.group_masks gm ON gm.group_id = mg.group_id
    WHERE mg.member_id = p_member_id
  ),
  forum_bits AS (
    SELECT
      l.id,
      COALESCE((
        SELECT bit_or(core.forum_mask_actions(l.id, m.mask_id))
        FROM masks m
      ), 0) AS actions
    FROM lineage l
  )
  SELECT
    COALESCE((SELECT actions FROM forum_bits WHERE id = p_forum_id), 0) & 2 <> 0
    AND COALESCE(bool_and((actions & 1) <> 0), false)
  FROM forum_bits;
$$;

REVOKE ALL ON FUNCTION core.can_read_forum(bigint, bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.has_mod_power(
  p_member_id bigint,
  p_forum_id bigint,
  p_power text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = core, pg_temp
AS $$
  SELECT
    EXISTS (SELECT 1 FROM core.forums WHERE id = p_forum_id)
    AND core.can_read_forum(p_member_id, p_forum_id)
    AND NOT EXISTS (
      SELECT 1
      FROM core.member_groups mg
      JOIN core.groups g ON g.id = mg.group_id
      WHERE mg.member_id = p_member_id
        AND g.key = 'banned'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM core.member_groups mg
      JOIN core.group_settings s ON s.group_id = mg.group_id
      WHERE mg.member_id = p_member_id
        AND s.key = 'restrictions.banned'
        AND s.value = 'true'::jsonb
    )
    AND (
      EXISTS (
        SELECT 1
        FROM core.member_groups mg
        JOIN core.group_settings s ON s.group_id = mg.group_id
        WHERE mg.member_id = p_member_id
          AND s.key = 'moderation.' || p_power
          AND s.value = 'true'::jsonb
      )
      OR
      EXISTS (
        SELECT 1
        FROM core.moderators m
        WHERE (m.member_id = p_member_id
               OR m.group_id IN (
                 SELECT mg.group_id FROM core.member_groups mg WHERE mg.member_id = p_member_id
               ))
          AND p_power = ANY (m.powers)
          AND m.forum_id IN (SELECT id FROM core.forum_lineage(p_forum_id))
          AND (NOT m.this_forum_only OR m.forum_id = p_forum_id)
      )
    );
$$;

REVOKE ALL ON FUNCTION core.has_mod_power(bigint, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.has_mod_power(bigint, bigint, text) TO pii_owner;
GRANT EXECUTE ON FUNCTION core.can_read_forum(bigint, bigint) TO pii_owner;

RESET ROLE;

GRANT SELECT, INSERT, UPDATE, DELETE ON core.forum_unlock_lockouts TO user_api;
GRANT SELECT ON core.forum_unlock_lockouts TO staff_api;
