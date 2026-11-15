import { queueSystemAudit } from "@bulletin/domain/audit";
import {
  advancePluginsGeneration,
  advancePluginsGenerationInTransaction,
  approvalMatches,
  type CapabilityReview,
  CatalogError,
  dropPluginNamespace,
  fetchMarketplacePlugin,
  grantElevatedAccess,
  notifyPluginHost,
  type PluginApproval,
  reviewCapabilities,
} from "@bulletin/domain/plugins";
import { opaqueKey, type StorageClient } from "@bulletin/storage";
import type { FormDefinition, FormValues } from "@bulletin/ui/forms/types";
import { validateForm } from "@bulletin/ui/forms/validate";
import type { SQL } from "bun";

/** Staff plugin manager data and plugin settings (ADR 0009, tasks 5.1/5.2). */

export interface BreakerRow {
  readonly hook: string;
  readonly failures: number;
  readonly disabledAt: string | null;
}

export interface PluginOperationRow {
  readonly step: string;
  readonly state: string;
  readonly error: string | null;
  readonly createdAt: string;
}

export interface PluginPage {
  readonly kind: "form" | "table" | "log";
  readonly id: string;
  readonly titleKey: string;
  readonly definition: FormDefinition | null;
}

export interface DeclaredPluginPage {
  readonly id: string;
  readonly kind: string;
  readonly titleKey: string;
  readonly definition: Readonly<Record<string, unknown>>;
}

export interface StaffPlugin {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly state: string;
  readonly enabled: boolean;
  readonly generation: number;
  readonly capabilities: readonly { capability: string; labelKey: string; elevated: boolean }[];
  readonly servicePrincipal: {
    readonly group: string;
    readonly elevatedForumIds: readonly string[];
    readonly warningKey: string | null;
  };
  readonly timings: Readonly<Record<string, number>>;
  readonly breaker: readonly BreakerRow[];
  readonly errors: readonly PluginOperationRow[];
  readonly pages: readonly PluginPage[];
  readonly declaredPages: readonly DeclaredPluginPage[];
}

interface PluginRow {
  readonly plugin_id: string;
  readonly name: string | null;
  readonly version: string;
  readonly state: string;
  readonly enabled: boolean;
  readonly generation: number;
  readonly capabilities: unknown;
  readonly service_principal_group: string;
  readonly elevated_grants: unknown;
  readonly timings: unknown;
  readonly last_error: string | null;
}

function grants(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) =>
      typeof entry === "object" && entry !== null
        ? String((entry as { forumId?: unknown }).forumId ?? "")
        : "",
    )
    .filter((id) => id !== "");
}

function timings(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

const FIELD_TYPES = new Set([
  "text",
  "number",
  "toggle",
  "select",
  "multi-select",
  "group-picker",
  "forum-picker",
  "duration",
  "markdown",
]);

function isField(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { labelKey?: unknown }).labelKey === "string" &&
    typeof (value as { type?: unknown }).type === "string" &&
    FIELD_TYPES.has((value as { type: string }).type)
  );
}

/** Plugin settings are untrusted declarations: only the core form shapes render. */
export function isFormDefinition(value: unknown): value is FormDefinition {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { id?: unknown }).id !== "string" ||
    !Array.isArray((value as { sections?: unknown }).sections)
  ) {
    return false;
  }

  return (value as { sections: unknown[] }).sections.every(
    (section) =>
      typeof section === "object" &&
      section !== null &&
      typeof (section as { id?: unknown }).id === "string" &&
      typeof (section as { titleKey?: unknown }).titleKey === "string" &&
      Array.isArray((section as { fields?: unknown }).fields) &&
      (section as { fields: unknown[] }).fields.every(isField),
  );
}

async function settingsDefinition(sql: SQL, pluginId: string): Promise<FormDefinition | null> {
  const rows = (await sql`
    SELECT definition FROM core.plugin_registry
    WHERE plugin_id = ${pluginId} AND kind = 'setting'
    LIMIT 1
  `) as Array<{ definition: unknown }>;
  const value = rows[0]?.definition;

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return isFormDefinition(value) ? value : null;
}

/** The global plugin switch also gates the staff plugin API, not just its navigation. */
export async function pluginsEnabled(sql: SQL): Promise<boolean> {
  const rows = (await sql`
    SELECT default_value FROM core.feature_flags WHERE key = 'plugins'
  `) as Array<{ default_value: boolean }>;
  return rows[0]?.default_value === true;
}

export async function listPlugins(sql: SQL): Promise<readonly StaffPlugin[]> {
  const [plugins, breakers, errors, declared] = await Promise.all([
    sql`
      SELECT plugin_id, name, version, state, enabled, generation, capabilities,
             service_principal_group, elevated_grants, timings, last_error
      FROM core.plugins
      ORDER BY plugin_id
    ` as Promise<PluginRow[]>,
    sql`
      SELECT plugin_id, hook, failures, last_error, disabled_at::text AS disabled_at
      FROM core.plugin_breaker
      ORDER BY plugin_id, hook
    ` as Promise<
      Array<{
        plugin_id: string;
        hook: string;
        failures: number;
        last_error: string | null;
        disabled_at: string | null;
      }>
    >,
    sql`
      SELECT plugin_id, step, state, error, created_at::text AS created_at
      FROM core.plugin_operations
      WHERE state = 'failed'
      ORDER BY id DESC
      LIMIT 100
    ` as Promise<
      Array<{
        plugin_id: string;
        step: string;
        state: string;
        error: string | null;
        created_at: string;
      }>
    >,
    sql`
      SELECT plugin_id, key, definition FROM core.plugin_registry
      WHERE kind = 'page'
      ORDER BY plugin_id, key
    ` as Promise<Array<{ plugin_id: string; key: string; definition: unknown }>>,
  ]);

  const result: StaffPlugin[] = [];

  for (const row of plugins) {
    const definition = await settingsDefinition(sql, row.plugin_id);
    const capabilities = Array.isArray(row.capabilities)
      ? row.capabilities.filter((value): value is string => typeof value === "string")
      : [];
    const elevated = grants(row.elevated_grants);
    const pages: PluginPage[] = [];

    if (definition !== null) {
      pages.push({
        kind: "form",
        id: "settings",
        titleKey: "staff.plugins.page.settings",
        definition,
      });
    }

    pages.push({
      kind: "table",
      id: "breaker",
      titleKey: "staff.plugins.page.health",
      definition: null,
    });
    pages.push({
      kind: "log",
      id: "errors",
      titleKey: "staff.plugins.page.errors",
      definition: null,
    });

    result.push({
      id: row.plugin_id,
      name: row.name ?? row.plugin_id,
      version: row.version,
      state: row.state,
      enabled: row.enabled,
      generation: row.generation,
      capabilities: reviewCapabilities(capabilities, []),
      servicePrincipal: {
        group: row.service_principal_group,
        elevatedForumIds: elevated,
        warningKey: elevated.length === 0 ? null : "staff.plugins.grant.warning",
      },
      timings: timings(row.timings),
      breaker: breakers
        .filter((entry) => entry.plugin_id === row.plugin_id)
        .map((entry) => ({
          hook: entry.hook,
          failures: entry.failures,
          disabledAt: entry.disabled_at,
        })),
      errors: [
        ...errors
          .filter((entry) => entry.plugin_id === row.plugin_id)
          .map((entry) => ({
            step: entry.step,
            state: entry.state,
            error: entry.error,
            createdAt: entry.created_at,
          })),
        ...breakers
          .filter((entry) => entry.plugin_id === row.plugin_id && entry.last_error !== null)
          .map((entry) => ({
            step: `hook:${entry.hook}`,
            state: "failed",
            error: entry.last_error,
            createdAt: entry.disabled_at ?? "",
          })),
      ],
      pages,
      declaredPages: declared
        .filter((page) => page.plugin_id === row.plugin_id)
        .map((page) => {
          const definition =
            typeof page.definition === "object" &&
            page.definition !== null &&
            !Array.isArray(page.definition)
              ? (page.definition as Record<string, unknown>)
              : {};
          return {
            id: page.key,
            kind: typeof definition.kind === "string" ? definition.kind : "table",
            titleKey:
              typeof definition.titleKey === "string"
                ? definition.titleKey
                : "staff.plugins.page.declared",
            definition,
          };
        }),
    });
  }

  return result;
}

export interface SettingsResult {
  readonly ok: boolean;
  readonly errors?: ReturnType<typeof validateForm>;
}

export async function savePluginSettings(
  sql: SQL,
  pluginId: string,
  values: FormValues,
  actorId: string,
): Promise<SettingsResult> {
  const definition = await settingsDefinition(sql, pluginId);

  if (definition === null) {
    return { ok: false };
  }

  const errors = validateForm(definition, values);

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  await sql.begin(async (tx) => {
    for (const [key, value] of Object.entries(values)) {
      await tx`
        INSERT INTO core.plugin_settings (plugin_id, key, value)
        VALUES (${pluginId}, ${key}, (${JSON.stringify(value ?? null)}::text)::jsonb)
        ON CONFLICT (plugin_id, key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = now()
      `;
    }

    await queueSystemAudit(tx, {
      action: "plugin.settings_saved",
      targetType: "plugin",
      summary: { pluginId, actorId, keys: Object.keys(values) },
    });
    await advancePluginsGenerationInTransaction(tx);
  });

  return { ok: true };
}

export async function pluginSettings(
  sql: SQL,
  pluginId: string,
): Promise<{ definition: FormDefinition; values: FormValues } | null> {
  const definition = await settingsDefinition(sql, pluginId);

  if (definition === null) {
    return null;
  }

  const rows = (await sql`
    SELECT key, value FROM core.plugin_settings WHERE plugin_id = ${pluginId}
  `) as Array<{ key: string; value: unknown }>;

  return {
    definition,
    values: Object.fromEntries(
      rows.map((row) => {
        const value = row.value;
        return [
          row.key,
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean" ||
          Array.isArray(value) ||
          (typeof value === "object" && value !== null)
            ? (value as never)
            : undefined,
        ];
      }),
    ),
  };
}

/** Sections a plugin adds to a core settings extension point, below the core sections. */
export async function extensionSections(
  sql: SQL,
  point: string,
): Promise<readonly { pluginId: string; definition: FormDefinition }[]> {
  const rows = (await sql`
    SELECT plugin_id, definition FROM core.plugin_registry
    WHERE kind = 'setting' AND definition->>'extensionPoint' = ${point}
    ORDER BY plugin_id
  `) as Array<{ plugin_id: string; definition: unknown }>;

  return rows
    .filter((row) => {
      const value = row.definition;
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        isFormDefinition(value)
      );
    })
    .map((row) => ({ pluginId: row.plugin_id, definition: row.definition as FormDefinition }));
}

async function bumpGeneration(sql: SQL): Promise<void> {
  await advancePluginsGeneration(sql);
}

export async function disablePlugin(sql: SQL, pluginId: string, actorId: string): Promise<void> {
  await sql`
    UPDATE core.plugins SET state = 'disabled', enabled = false, updated_at = now()
    WHERE plugin_id = ${pluginId}
  `;
  // plugin-host stops the sandbox when it reconciles; the row above is the durable state.
  await notifyPluginHost(sql, pluginId);
  await sql`
    DELETE FROM core.hook_fragments
    WHERE plugin_id = ${pluginId}
      AND generation = (SELECT generation FROM core.plugin_generation WHERE id = true)
  `;
  await bumpGeneration(sql);
  await queueSystemAudit(sql, {
    action: "plugin.disabled",
    targetType: "plugin",
    summary: { pluginId, actorId },
  });
}

export async function uninstallPlugin(
  sql: SQL,
  pluginId: string,
  actorId: string,
  dataAction: "keep" | "drop" | "erase",
): Promise<void> {
  // Identifiers below are interpolated into DDL, so accept only the installed plugin's
  // validated id shape before any unsafe SQL is built.
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(pluginId)) {
    throw new TypeError("Invalid plugin id");
  }

  const existing = (await sql`
    SELECT 1 FROM core.plugins WHERE plugin_id = ${pluginId} LIMIT 1
  `) as unknown[];

  if (existing.length === 0) {
    throw new Error("Plugin is not installed");
  }

  await disablePlugin(sql, pluginId, actorId);

  if (dataAction !== "keep") {
    // Ownership-checked and role-namespaced, so dropping this plugin can never drop another
    // plugin's schema or objects (ADR 0009).
    await dropPluginNamespace(sql, pluginId);
  }

  await sql`DELETE FROM core.plugin_registry WHERE plugin_id = ${pluginId}`;
  await sql`DELETE FROM core.plugin_settings WHERE plugin_id = ${pluginId}`;
  await sql`DELETE FROM core.plugin_jobs WHERE plugin_id = ${pluginId}`;
  await sql`DELETE FROM core.plugin_event_subscriptions WHERE plugin_id = ${pluginId}`;
  await sql`
    UPDATE core.plugins
    SET state = 'uninstalled', enabled = false, updated_at = now()
    WHERE plugin_id = ${pluginId}
  `;
  await notifyPluginHost(sql, pluginId);
  await queueSystemAudit(sql, {
    action: "plugin.uninstalled",
    targetType: "plugin",
    summary: { pluginId, actorId, dataAction },
  });
}

export async function grantPluginAccess(
  sql: SQL,
  pluginId: string,
  forumIds: readonly string[],
  actorId: string,
): Promise<void> {
  await grantElevatedAccess(sql, { pluginId, forumIds, actorId });
}

export type InstallFailure =
  | "not_found"
  | "incompatible"
  | "already_installed"
  | "approval_mismatch"
  | "marketplace_unavailable"
  | "invalid_bundle";

export interface PluginReview {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly capabilities: readonly string[];
  readonly egressHosts: readonly string[];
  /** Plain-language list for the review screen, elevated access flagged. */
  readonly review: readonly CapabilityReview[];
}

function installFailure(error: unknown): InstallFailure {
  if (error instanceof CatalogError) {
    switch (error.code) {
      case "not_found":
        return "not_found";
      case "incompatible":
        return "incompatible";
      case "catalog":
        return "invalid_bundle";
      default:
        return error.code === "checksum" || error.code === "bundle_signature"
          ? "invalid_bundle"
          : "marketplace_unavailable";
    }
  }

  // A manifest that fails to parse is a bad bundle; network errors are an unavailable market.
  return error instanceof TypeError ? "marketplace_unavailable" : "invalid_bundle";
}

async function installable(sql: SQL, pluginId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT state FROM core.plugins WHERE plugin_id = ${pluginId}
  `) as Array<{ state: string }>;
  const state = rows[0]?.state;
  return state === undefined || state === "uninstalled" || state === "failed";
}

/** Downloads and verifies a catalog bundle, and returns what it will ask the admin to approve. */
export async function reviewMarketplacePlugin(
  sql: SQL,
  options: {
    readonly baseUrl: string;
    readonly pluginId: string;
    readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  },
): Promise<{ ok: true; review: PluginReview } | { ok: false; code: InstallFailure }> {
  if (!(await installable(sql, options.pluginId))) {
    return { ok: false, code: "already_installed" };
  }

  try {
    const plugin = await fetchMarketplacePlugin(options);
    return {
      ok: true,
      review: {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        description: plugin.entry.description,
        author: plugin.entry.author,
        capabilities: plugin.manifest.capabilities,
        egressHosts: plugin.manifest.egressHosts,
        review: reviewCapabilities(plugin.manifest.capabilities, plugin.manifest.egressHosts),
      },
    };
  } catch (error) {
    return { ok: false, code: installFailure(error) };
  }
}

/**
 * Stores a verified, approved bundle and asks plugin-host to run it (ADR 0009). The row is
 * left `installing`; plugin-host provisions the schema, runs migrations, starts the sandbox,
 * publishes fragments and moves it to `active` or `failed`.
 */
export async function requestPluginInstall(
  sql: SQL,
  options: {
    readonly storage: StorageClient;
    readonly baseUrl: string;
    readonly pluginId: string;
    readonly approval: PluginApproval;
    readonly actorId: string;
    readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  },
): Promise<{ ok: true } | { ok: false; code: InstallFailure }> {
  if (!(await installable(sql, options.pluginId))) {
    return { ok: false, code: "already_installed" };
  }

  let plugin: Awaited<ReturnType<typeof fetchMarketplacePlugin>>;

  try {
    plugin = await fetchMarketplacePlugin(options);
  } catch (error) {
    return { ok: false, code: installFailure(error) };
  }

  if (!approvalMatches(plugin.manifest, options.approval)) {
    return { ok: false, code: "approval_mismatch" };
  }

  const { manifest, verified } = plugin;
  // The verified bytes go to object storage under an opaque key; the row holds the key and the
  // checksum plugin-host re-checks before it unpacks anything (ADR 0009, 0019).
  const bundleKey = opaqueKey("plugin");
  await options.storage.put(bundleKey, verified.bundle, { contentType: "application/x-tar" });
  const personalData = manifest.personalData.map((entry) => ({
    table: entry.table,
    memberColumn: entry.memberColumn,
  }));

  const stored = await sql.begin(async (tx) => {
    // Re-check under the row lock: two admins installing at once must not both win.
    const current = (await tx`
      SELECT state FROM core.plugins WHERE plugin_id = ${manifest.id} FOR UPDATE
    `) as Array<{ state: string }>;
    const state = current[0]?.state;

    if (state !== undefined && state !== "uninstalled" && state !== "failed") {
      return false;
    }

    await tx`
      INSERT INTO core.plugins (
        plugin_id, name, version, sdk_version, state, enabled, capabilities,
        approved_capabilities, approved_egress_hosts, personal_data,
        bundle, bundle_key, signature, checksum, error, last_error
      ) VALUES (
        ${manifest.id}, ${manifest.name}, ${manifest.version}, ${manifest.sdkVersion},
        'installing', true, (${JSON.stringify(manifest.capabilities)}::text)::jsonb,
        (${JSON.stringify(manifest.capabilities)}::text)::jsonb,
        (${JSON.stringify(manifest.egressHosts)}::text)::jsonb,
        (${JSON.stringify(personalData)}::text)::jsonb,
        NULL, ${bundleKey}, ${verified.signature}, ${verified.checksum}, NULL, NULL
      )
      ON CONFLICT (plugin_id) DO UPDATE SET
        name = EXCLUDED.name,
        version = EXCLUDED.version,
        sdk_version = EXCLUDED.sdk_version,
        state = 'installing',
        enabled = true,
        capabilities = EXCLUDED.capabilities,
        approved_capabilities = EXCLUDED.approved_capabilities,
        approved_egress_hosts = EXCLUDED.approved_egress_hosts,
        personal_data = EXCLUDED.personal_data,
        bundle = NULL,
        bundle_key = EXCLUDED.bundle_key,
        signature = EXCLUDED.signature,
        checksum = EXCLUDED.checksum,
        error = NULL,
        last_error = NULL,
        installed_at = now(),
        updated_at = now()
    `;

    for (const declaration of personalData) {
      await tx`
        INSERT INTO core.plugin_personal_data (plugin_id, table_name, member_column)
        VALUES (${manifest.id}, ${declaration.table}, ${declaration.memberColumn})
        ON CONFLICT DO NOTHING
      `;
    }

    await tx`
      INSERT INTO core.plugin_operations (plugin_id, kind, step, state)
      VALUES (${manifest.id}, 'install', 'requested', 'completed')
    `;
    await queueSystemAudit(tx, {
      action: "plugin.install_requested",
      targetType: "plugin",
      summary: {
        pluginId: manifest.id,
        actorId: options.actorId,
        version: manifest.version,
        capabilities: manifest.capabilities,
        egressHosts: manifest.egressHosts,
      },
    });
    await notifyPluginHost(tx, manifest.id);
    return true;
  });

  if (!stored) {
    await options.storage.delete(bundleKey).catch(() => undefined);
    return { ok: false, code: "already_installed" };
  }

  return { ok: true };
}

/** Re-enables a disabled or failed plugin; plugin-host restarts it and marks it active. */
export async function enablePlugin(
  sql: SQL,
  pluginId: string,
  actorId: string,
): Promise<{ ok: true } | { ok: false; code: "not_found" | "state" }> {
  return sql.begin(async (tx) => {
    const rows = (await tx`
      SELECT state FROM core.plugins WHERE plugin_id = ${pluginId} FOR UPDATE
    `) as Array<{ state: string }>;
    const state = rows[0]?.state;

    if (state === undefined) {
      return { ok: false as const, code: "not_found" as const };
    }

    if (state !== "disabled" && state !== "failed") {
      return { ok: false as const, code: "state" as const };
    }

    await tx`
      UPDATE core.plugins
      SET state = 'installing', enabled = true, error = NULL, updated_at = now()
      WHERE plugin_id = ${pluginId}
    `;
    // A plugin the circuit breaker turned off starts with a clean failure count.
    await tx`DELETE FROM core.plugin_breaker WHERE plugin_id = ${pluginId}`;
    await queueSystemAudit(tx, {
      action: "plugin.enabled",
      targetType: "plugin",
      summary: { pluginId, actorId },
    });
    await notifyPluginHost(tx, pluginId);
    return { ok: true as const };
  });
}
