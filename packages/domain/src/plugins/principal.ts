import type { SQL } from "bun";
import { queueSystemAudit } from "../audit/index.ts";

/**
 * Plugin service principals (ADR 0009). Background access defaults to Guests; an admin may
 * grant read access to named forums, which is recorded with a red warning and in the admin log.
 */

export const DEFAULT_SERVICE_PRINCIPAL_GROUP = "Guests";

export interface ServicePrincipal {
  readonly group: string;
  /** Forum ids explicitly granted beyond Guests. */
  readonly elevatedForumIds: readonly string[];
  readonly warningKey: string | null;
}

export interface ElevatedGrantInput {
  readonly pluginId: string;
  readonly forumIds: readonly string[];
  readonly actorId: string;
}

export function servicePrincipal(value: {
  readonly service_principal_group?: string | null;
  readonly elevated_grants?: unknown;
}): ServicePrincipal {
  const grants = Array.isArray(value.elevated_grants)
    ? value.elevated_grants
        .map((entry) =>
          typeof entry === "object" && entry !== null
            ? String((entry as { forumId?: unknown }).forumId ?? "")
            : "",
        )
        .filter((id) => id !== "")
    : [];
  const group = value.service_principal_group ?? DEFAULT_SERVICE_PRINCIPAL_GROUP;

  return {
    group,
    elevatedForumIds: grants,
    warningKey: grants.length === 0 ? null : "staff.plugins.grant.warning",
  };
}

export async function loadServicePrincipal(
  sql: SQL,
  pluginId: string,
): Promise<ServicePrincipal | null> {
  const rows = (await sql`
    SELECT service_principal_group, elevated_grants
    FROM core.plugins
    WHERE plugin_id = ${pluginId}
  `) as Array<{ service_principal_group: string; elevated_grants: unknown }>;

  return rows[0] === undefined ? null : servicePrincipal(rows[0]);
}

/**
 * Grants elevated forum read access. The warning names the forums and says the plugin can
 * display or repost the content; the same grant is written to the admin log.
 */
export async function grantElevatedAccess(
  sql: SQL,
  input: ElevatedGrantInput,
): Promise<ServicePrincipal> {
  const unique = [...new Set(input.forumIds.filter((id) => /^\d+$/.test(id)))];

  if (unique.length === 0) {
    throw new TypeError("At least one forum id is required for an elevated grant");
  }

  const grants = unique.map((forumId) => ({
    forumId,
    warningKey: "staff.plugins.grant.warning",
  }));

  await sql.begin(async (tx) => {
    await tx`
      UPDATE core.plugins
      SET elevated_grants = ${JSON.stringify(grants)}::jsonb, updated_at = now()
      WHERE plugin_id = ${input.pluginId}
    `;
    await queueSystemAudit(tx, {
      action: "plugin.elevated_grant",
      targetType: "plugin",
      summary: {
        pluginId: input.pluginId,
        actorId: input.actorId,
        forumIds: unique,
        warningKey: "staff.plugins.grant.warning",
      },
    });
  });

  return servicePrincipal({ elevated_grants: grants });
}

export async function revokeElevatedAccess(sql: SQL, pluginId: string): Promise<void> {
  await sql`
    UPDATE core.plugins
    SET elevated_grants = '[]'::jsonb, updated_at = now()
    WHERE plugin_id = ${pluginId}
  `;
}
