import type { SQL } from "bun";

export interface StoredTheme {
  readonly theme: string;
  readonly version: number;
  readonly templates: ReadonlyMap<string, string>;
}

interface ThemeRow {
  readonly theme: string;
  readonly version: number;
}

interface TemplateRow {
  readonly name: string;
  readonly body: string;
}

interface HookRow {
  readonly name: string;
  readonly body: string;
}

/**
 * Loads one spike theme and its template bodies (ADR 0008). Spike S1 scaffolding: task 2.1
 * adds parent-theme fallback and the compile cache on top of this query.
 */
export async function loadStoredTheme(sql: SQL, theme: string): Promise<StoredTheme | null> {
  const rows = (await sql`
    SELECT name AS theme, version
    FROM core.render_spike_themes
    WHERE name = ${theme}
  `) as ThemeRow[];
  const row = rows[0];

  if (row === undefined) {
    return null;
  }

  const templates = (await sql`
    SELECT name, body
    FROM core.render_spike_templates
    WHERE theme_name = ${theme}
    ORDER BY name
  `) as TemplateRow[];

  return {
    theme: row.theme,
    version: row.version,
    templates: new Map(templates.map((template) => [template.name, template.body])),
  };
}

/** Loads the hook fragments a plugin generation contributes, keyed by hook name. */
export async function loadHookFragments(
  sql: SQL,
  generation: number,
): Promise<Readonly<Record<string, string>>> {
  const rows = (await sql`
    SELECT name, body
    FROM core.render_spike_hooks
    WHERE generation = ${generation}
    ORDER BY name
  `) as HookRow[];

  return Object.fromEntries(rows.map((row) => [row.name, row.body]));
}
