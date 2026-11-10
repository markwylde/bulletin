import type { SQL } from "bun";

/**
 * The interim ACP permission set for this change. `groups-permissions` replaces this with the
 * typed group-settings registry; until then the built-in groups grant these explicitly.
 */
export const ACP_PERMISSIONS = [
  "acp.access",
  "acp.flags",
  "acp.log",
  "acp.members",
  "acp.settings",
  "acp.strings",
  "acp.system",
] as const;

export type AcpPermission = (typeof ACP_PERMISSIONS)[number];

export function isAcpPermission(value: string): value is AcpPermission {
  return (ACP_PERMISSIONS as readonly string[]).includes(value);
}

export const STAFF_SCHEMES = ["light", "dark", "system"] as const;

export type StaffScheme = (typeof STAFF_SCHEMES)[number];

export const DEFAULT_STAFF_SCHEME: StaffScheme = "system";

export function isStaffScheme(value: unknown): value is StaffScheme {
  return typeof value === "string" && (STAFF_SCHEMES as readonly string[]).includes(value);
}

/**
 * The ACP permissions a member's groups grant, in registry order. Duplicate grants across
 * secondary groups collapse into one entry.
 */
export async function acpPermissionsFor(sql: SQL, memberId: string): Promise<AcpPermission[]> {
  const rows = (await sql`
    SELECT DISTINCT p.permission
    FROM core.member_groups mg
    JOIN core.group_acp_permissions p ON p.group_id = mg.group_id
    WHERE mg.member_id = ${memberId}
  `) as Array<{ permission: string }>;
  const granted = new Set(rows.map((row) => row.permission));

  return ACP_PERMISSIONS.filter((permission) => granted.has(permission));
}
