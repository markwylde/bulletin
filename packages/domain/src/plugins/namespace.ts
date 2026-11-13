import type { SQL } from "bun";
import { type PluginIdentifiers, pluginIdentifiers, pluginRoleMarker } from "./identifiers.ts";

/**
 * Ownership checks and removal for the Postgres namespace of one plugin (ADR 0009).
 * Names are disjoint by construction (see `identifiers.ts`), but the installer and uninstall
 * still verify the ownership markers first: a role or schema that happens to carry a derived
 * name but was not created for this plugin is never taken over or dropped.
 */
export class PluginNamespaceCollisionError extends Error {
  constructor(identifier: string, kind: "role" | "schema") {
    super(`Plugin ${kind} ${identifier} already exists and is not owned by this plugin`);
    this.name = "PluginNamespaceCollisionError";
  }
}

/** The role marker written by the installer, e.g. `bulletin:plugin:tip-jar`. */
export function ownsPluginRole(marker: string | null, pluginId: string): boolean {
  return marker === pluginRoleMarker(pluginId);
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

interface RoleMarkerRow {
  readonly rolname: string;
  readonly marker: string | null;
}

/** Reads the ownership marker of a role; absent roles are reported as `undefined`. */
export async function pluginRoleMarkers(
  sql: SQL,
  names: readonly string[],
): Promise<ReadonlyMap<string, string | null>> {
  const rows = (await sql`
    SELECT rolname, shobj_description(oid, 'pg_authid') AS marker
    FROM pg_roles
    WHERE rolname = ANY(string_to_array(${names.join(",")}, ','))
  `) as RoleMarkerRow[];

  return new Map(rows.map((row) => [row.rolname, row.marker]));
}

/** Throws unless every existing derived role carries this plugin's ownership marker. */
export async function assertPluginRolesOwned(
  sql: SQL,
  identifiers: PluginIdentifiers,
): Promise<void> {
  const markers = await pluginRoleMarkers(sql, [identifiers.runtimeRole, identifiers.ownerRole]);

  for (const role of [identifiers.runtimeRole, identifiers.ownerRole]) {
    if (markers.has(role) && !ownsPluginRole(markers.get(role) ?? null, identifiers.pluginId)) {
      throw new PluginNamespaceCollisionError(role, "role");
    }
  }
}

/** Throws when the schema exists but is not owned by this plugin's owner role. */
export async function assertPluginSchemaOwned(
  sql: SQL,
  identifiers: PluginIdentifiers,
): Promise<void> {
  const schemas = (await sql`
    SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = ${identifiers.schema}
  `) as Array<{ owner: string }>;

  if (schemas.length > 0 && schemas[0]?.owner !== identifiers.ownerRole) {
    throw new PluginNamespaceCollisionError(identifiers.schema, "schema");
  }
}

/**
 * Drops the plugin's schema and both roles, after proving this plugin owns them. Safe to run
 * when nothing was provisioned (uninstall with no data), and never touches another plugin's
 * objects: `DROP OWNED` runs for disjoint, verified role names only.
 */
export async function dropPluginNamespace(sql: SQL, pluginId: string): Promise<void> {
  const identifiers = pluginIdentifiers(pluginId);
  await assertPluginRolesOwned(sql, identifiers);
  await assertPluginSchemaOwned(sql, identifiers);

  const markers = await pluginRoleMarkers(sql, [identifiers.runtimeRole, identifiers.ownerRole]);
  const existing = [identifiers.runtimeRole, identifiers.ownerRole].filter((role) =>
    markers.has(role),
  );
  const migratorExists = (await sql`
    SELECT 1 FROM pg_roles WHERE rolname = 'plugin_migrator'
  `) as unknown[];

  if (migratorExists.length > 0 && markers.has(identifiers.ownerRole)) {
    await sql.unsafe(`REVOKE ${quote(identifiers.ownerRole)} FROM ${quote("plugin_migrator")}`);
  }

  await sql.unsafe(`DROP SCHEMA IF EXISTS ${quote(identifiers.schema)} CASCADE`);

  if (existing.length > 0) {
    await sql.unsafe(`DROP OWNED BY ${existing.map(quote).join(", ")}`);
  }

  for (const role of existing) {
    await sql.unsafe(`DROP ROLE IF EXISTS ${quote(role)}`);
  }
}
