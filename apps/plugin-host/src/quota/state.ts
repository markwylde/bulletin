import type { SQL } from "bun";

/**
 * Durable storage-quota state (ADR 0009). The revocation lives in Postgres so it survives a
 * broker restart; provisioning reads it before it grants DML to a plugin's runtime role.
 */

/** The persisted flag, or `false` when the plugin has no row (or the table is not migrated). */
export async function readWritesRevoked(sql: SQL, pluginId: string): Promise<boolean> {
  try {
    const rows = (await sql`
      SELECT writes_revoked FROM core.plugin_quota WHERE plugin_id = ${pluginId}
    `) as Array<{ writes_revoked: boolean }>;

    return rows[0]?.writes_revoked === true;
  } catch {
    // A plugin cluster that has not run the core migrations yet simply has no state.
    return false;
  }
}

export async function saveWritesRevoked(
  sql: SQL,
  pluginId: string,
  writesRevoked: boolean,
): Promise<void> {
  await sql`
    INSERT INTO core.plugin_quota (plugin_id, writes_revoked, updated_at)
    VALUES (${pluginId}, ${writesRevoked}, now())
    ON CONFLICT (plugin_id)
    DO UPDATE SET writes_revoked = EXCLUDED.writes_revoked, updated_at = now()
  `;
}
