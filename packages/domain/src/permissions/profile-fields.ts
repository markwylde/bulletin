import type { SQL } from "bun";
import type { ViewerPrincipal } from "./principal.ts";
import { loadMemberGroups } from "./store.ts";

interface FieldVisibilityRow {
  readonly id: string;
  readonly restricted: boolean;
  readonly visible: boolean;
}

async function viewerGroupIds(sql: SQL, principal: ViewerPrincipal): Promise<readonly string[]> {
  return (await loadMemberGroups(sql, principal)).map((group) => group.groupId);
}

function groupArray(groupIds: readonly string[]): string {
  return `{${groupIds.join(",")}}`;
}

/**
 * The viewer's field-visibility class: the set of custom profile field IDs their groups may
 * see, plus a stable hash used as part of the profile cache variant (ADR 0005, 0006).
 *
 * A field with no group rows is public; a restricted field is visible only to a group whose
 * row grants `can_view`.
 */
export async function profileFieldVisibilityClass(
  sql: SQL,
  principal: ViewerPrincipal,
): Promise<{ readonly ids: ReadonlySet<string>; readonly hash: string }> {
  const groupIds = await viewerGroupIds(sql, principal);
  const rows =
    groupIds.length === 0
      ? ((await sql`
          SELECT
            f.id::text AS id,
            EXISTS (
              SELECT 1 FROM core.profile_field_groups all_rules
              WHERE all_rules.field_id = f.id
            ) AS restricted,
            false AS visible
          FROM core.profile_fields f
        `) as FieldVisibilityRow[])
      : ((await sql`
          SELECT
            f.id::text AS id,
            EXISTS (
              SELECT 1 FROM core.profile_field_groups all_rules
              WHERE all_rules.field_id = f.id
            ) AS restricted,
            COALESCE(bool_or(r.can_view), false) AS visible
          FROM core.profile_fields f
          LEFT JOIN core.profile_field_groups r
            ON r.field_id = f.id
           AND r.group_id = ANY(${groupArray(groupIds)}::bigint[])
          GROUP BY f.id
        `) as FieldVisibilityRow[]);

  const ids = new Set(rows.filter((row) => !row.restricted || row.visible).map((row) => row.id));
  const hash = new Bun.CryptoHasher("sha256").update([...ids].sort().join(",")).digest("hex");

  return { ids, hash };
}

async function fieldRule(
  sql: SQL,
  principal: ViewerPrincipal,
  fieldId: string,
  rule: "can_view" | "can_edit",
): Promise<boolean> {
  if (!/^\d+$/.test(fieldId)) {
    return false;
  }

  const groupIds = await viewerGroupIds(sql, principal);

  if (groupIds.length === 0) {
    return false;
  }

  const groups = groupArray(groupIds);
  const rows =
    rule === "can_view"
      ? ((await sql`
          SELECT 1
          FROM core.profile_field_groups r
          WHERE r.field_id = ${fieldId}
            AND r.group_id = ANY(${groups}::bigint[])
            AND r.can_view
          LIMIT 1
        `) as unknown[])
      : ((await sql`
          SELECT 1
          FROM core.profile_field_groups r
          WHERE r.field_id = ${fieldId}
            AND r.group_id = ANY(${groups}::bigint[])
            AND r.can_edit
          LIMIT 1
        `) as unknown[]);

  return rows.length > 0;
}

/** Custom field visibility through the single authorisation entry point (ADR 0005). */
export async function canViewProfileField(
  sql: SQL,
  principal: ViewerPrincipal,
  fieldId: string,
): Promise<boolean> {
  const [field] = (await sql`
    SELECT id::text AS id FROM core.profile_fields WHERE id = ${fieldId}
  `) as Array<{ id: string }>;

  if (field === undefined) {
    return false;
  }

  const [restricted] = (await sql`
    SELECT EXISTS (
      SELECT 1 FROM core.profile_field_groups WHERE field_id = ${fieldId}
    ) AS restricted
  `) as Array<{ restricted: boolean }>;

  return restricted?.restricted !== true || fieldRule(sql, principal, fieldId, "can_view");
}

/** Custom field editing is only for a group whose row grants `can_edit`. */
export async function canEditProfileField(
  sql: SQL,
  principal: ViewerPrincipal,
  fieldId: string,
): Promise<boolean> {
  return fieldRule(sql, principal, fieldId, "can_edit");
}

/** The set of fields the viewer's groups may edit, in one query for the edit form. */
export async function editableProfileFieldIds(
  sql: SQL,
  principal: ViewerPrincipal,
): Promise<ReadonlySet<string>> {
  const groupIds = await viewerGroupIds(sql, principal);

  if (groupIds.length === 0) {
    return new Set();
  }

  const rows = (await sql`
    SELECT DISTINCT r.field_id::text AS field_id
    FROM core.profile_field_groups r
    WHERE r.group_id = ANY(${groupArray(groupIds)}::bigint[])
      AND r.can_edit
  `) as Array<{ field_id: string }>;

  return new Set(rows.map((row) => row.field_id));
}
