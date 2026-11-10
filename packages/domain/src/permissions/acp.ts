import type { SQL } from "bun";
import { type AcpPermission, isAcpPermissionKey, PERMISSION_KEYS } from "./registry.ts";

/**
 * The ACP permission set from the typed registry (ADR 0005). `groups-permissions` replaced the
 * interim `core.group_acp_permissions` table with registry entries in `core.group_settings`.
 */
export const ACP_PERMISSIONS: readonly AcpPermission[] = PERMISSION_KEYS.filter(isAcpPermissionKey);

export function isAcpPermission(value: string): value is AcpPermission {
  return isAcpPermissionKey(value);
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
    SELECT DISTINCT s.key
    FROM core.member_groups mg
    JOIN core.group_settings s ON s.group_id = mg.group_id
    WHERE mg.member_id = ${memberId}
      AND s.key LIKE 'acp.%'
      AND s.value = 'true'::jsonb
  `) as Array<{ key: string }>;
  const granted = new Set(rows.map((row) => row.key));

  return ACP_PERMISSIONS.filter((permission) => granted.has(permission));
}
