/**
 * Names for the Postgres objects that belong to one plugin (ADR 0009). The installer, the
 * broker, the quota monitor and uninstall all derive them here, so they can never drift.
 *
 * Isolation depends on these being disjoint: one plugin's runtime role must never be another
 * plugin's owner role, and no plugin may alias a platform role. Plugin ids contain only
 * lowercase letters, digits and hyphens, and each role kind has its own fixed prefix followed
 * by a `__` separator, so an id can never forge another kind's name. Postgres truncates
 * identifiers at 63 bytes; the longest id (49) plus the longest prefix (12) stays below it.
 */

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}$/;

/** Platform-owned roles that no plugin identifier may derive. */
export const RESERVED_DATABASE_ROLES: ReadonlySet<string> = new Set([
  "postgres",
  "bulletin_owner",
  "pii_owner",
  "user_app",
  "user_api",
  "staff_api",
  "workers",
  "plugin_migrator",
]);

/** Marks a role as created for one plugin, so a reinstall can prove it owns the name. */
export const PLUGIN_ROLE_MARKER_PREFIX = "bulletin:plugin:";

const SCHEMA_PREFIX = "plugin_";
const RUNTIME_ROLE_PREFIX = "plugin_rt__";
const OWNER_ROLE_PREFIX = "plugin_own__";

export interface PluginIdentifiers {
  readonly pluginId: string;
  readonly schema: string;
  readonly runtimeRole: string;
  readonly ownerRole: string;
}

/** The comment the installer writes on a role it created for this plugin. */
export function pluginRoleMarker(pluginId: string): string {
  return `${PLUGIN_ROLE_MARKER_PREFIX}${pluginId}`;
}

export function pluginIdentifiers(pluginId: string): PluginIdentifiers {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new TypeError("Plugin id must be 1-49 lowercase letters, digits or hyphens");
  }

  // Hyphens are the only character normalization touches, and ids cannot contain an
  // underscore, so distinct ids always produce distinct normalized names.
  const normalized = pluginId.replaceAll("-", "_");
  const identifiers = {
    pluginId,
    schema: `${SCHEMA_PREFIX}${normalized}`,
    runtimeRole: `${RUNTIME_ROLE_PREFIX}${normalized}`,
    ownerRole: `${OWNER_ROLE_PREFIX}${normalized}`,
  } satisfies PluginIdentifiers;

  for (const role of [identifiers.runtimeRole, identifiers.ownerRole]) {
    if (RESERVED_DATABASE_ROLES.has(role)) {
      throw new TypeError(`Plugin id ${pluginId} derives a reserved database role`);
    }
  }

  return identifiers;
}
