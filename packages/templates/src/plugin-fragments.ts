import type { SQL } from "bun";
import type { LoadedTheme, StoredThemeTemplate } from "./store.ts";

/** One plugin fragment row for a pluginsGeneration (ADR 0009). */
export interface PluginFragment {
  readonly name: string;
  readonly body: string;
  readonly kind: "hook" | "override";
  readonly pluginId: string | null;
}

export interface PluginFragments {
  /** Bodies injected at `{% hook "name" %}` points. */
  readonly hooks: Readonly<Record<string, string>>;
  /** Whole-template overrides, newest plugin generation only. */
  readonly overrides: readonly PluginFragment[];
}

interface FragmentRow {
  readonly name: string;
  readonly body: string;
  readonly kind: string;
  readonly plugin_id: string | null;
}

/** Loads the hook fragments and overrides for one plugin generation. */
export async function loadPluginFragments(sql: SQL, generation: number): Promise<PluginFragments> {
  const rows = (await sql`
    SELECT name, body, kind, plugin_id
    FROM core.hook_fragments
    WHERE generation = ${generation}
    ORDER BY name
  `) as FragmentRow[];
  const hooks: Record<string, string> = {};
  const overrides: PluginFragment[] = [];

  for (const row of rows) {
    const kind = row.kind === "override" ? "override" : "hook";

    if (kind === "override") {
      overrides.push({
        name: row.name,
        body: row.body,
        kind,
        pluginId: row.plugin_id,
      });
    } else {
      hooks[row.name] = row.body;
    }
  }

  return { hooks, overrides };
}

/** Hook fragments only, kept for callers that do not need template overrides. */
export async function loadHookFragments(
  sql: SQL,
  generation: number,
): Promise<Readonly<Record<string, string>>> {
  return (await loadPluginFragments(sql, generation)).hooks;
}

/** The current pluginsGeneration; toggling a plugin bumps this row (ADR 0006, 0009). */
export async function loadPluginsGeneration(sql: SQL): Promise<number> {
  const rows = (await sql`
    SELECT generation FROM core.plugin_generation WHERE id = true
  `) as Array<{ generation: number }>;

  return rows[0]?.generation ?? 1;
}

/** Bumps pluginsGeneration so compiled fragments and cached pages miss. */
export async function bumpPluginsGeneration(sql: SQL): Promise<number> {
  const rows = (await sql`
    UPDATE core.plugin_generation
    SET generation = generation + 1, updated_at = now()
    WHERE id = true
    RETURNING generation
  `) as Array<{ generation: number }>;

  return rows[0]?.generation ?? 1;
}

/**
 * Prepends plugin overrides to a loaded theme, so a plugin can replace a named template while
 * the theme's own version remains the fallback. A broken override falls back to the theme.
 */
export function applyPluginOverrides(
  theme: LoadedTheme,
  overrides: readonly PluginFragment[],
): LoadedTheme {
  if (overrides.length === 0) {
    return theme;
  }

  const templates = new Map(theme.templates);

  for (const override of overrides) {
    const pluginTemplate: StoredThemeTemplate = {
      themeId: `plugin:${override.pluginId ?? "unknown"}`,
      themeName: `plugin:${override.pluginId ?? "unknown"}`,
      name: override.name,
      body: override.body,
      version: 1,
    };
    const existing = templates.get(override.name) ?? [];
    templates.set(override.name, [pluginTemplate, ...existing]);
  }

  return { ...theme, templates };
}
