import { queueSystemAudit } from "@bulletin/domain/audit";
import {
  advancePluginsGeneration,
  advancePluginsGenerationInTransaction,
  grantElevatedAccess,
  reviewCapabilities,
} from "@bulletin/domain/plugins";
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

export async function listPlugins(sql: SQL): Promise<readonly StaffPlugin[]> {
  const [plugins, breakers, errors, declared] = await Promise.all([
    sql`
      SELECT plugin_id, name, version, state, enabled, generation, capabilities,
             service_principal_group, elevated_grants, timings, last_error
      FROM core.plugins
      ORDER BY plugin_id
    ` as Promise<PluginRow[]>,
    sql`
      SELECT plugin_id, hook, failures, disabled_at::text AS disabled_at
      FROM core.plugin_breaker
      ORDER BY plugin_id, hook
    ` as Promise<
      Array<{ plugin_id: string; hook: string; failures: number; disabled_at: string | null }>
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
      errors: errors
        .filter((entry) => entry.plugin_id === row.plugin_id)
        .map((entry) => ({
          step: entry.step,
          state: entry.state,
          error: entry.error,
          createdAt: entry.created_at,
        })),
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
  await disablePlugin(sql, pluginId, actorId);

  if (dataAction !== "keep") {
    const schema = `plugin_${pluginId.replaceAll("-", "_")}`;
    const owner = `${schema}_owner`;
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await sql.unsafe(`DROP OWNED BY "${schema}", "${owner}"`);
    await sql.unsafe(`DROP ROLE IF EXISTS "${schema}"`);
    await sql.unsafe(`DROP ROLE IF EXISTS "${owner}"`);
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
