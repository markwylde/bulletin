-- 0022: root inheritance fix for the SQL visibility mirror (ADR 0005).
-- A root forum row marked `inherits = true` inherits from nothing, so its seeded action bits
-- must resolve to zero (the TypeScript compiler starts the chain at zero). The previous SQL
-- function returned the root's raw actions for that case.

SET LOCAL ROLE bulletin_owner;

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
    SELECT
      id,
      level,
      CASE WHEN missing OR inherits THEN 0 ELSE actions END AS value
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

RESET ROLE;
