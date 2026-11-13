import type { SQL } from "bun";

/** One theme in an inheritance chain, leaf first. */
export interface ThemeRecord {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly parentId: string | null;
}

/** Where a theme came from; only the bundled theme is our code (ADR 0008). */
export type ThemeSource = "core" | "marketplace" | "upload" | "custom";

/** One template row exactly as stored for a theme (an override, not resolved). */
export interface StoredThemeTemplate {
  readonly themeId: string;
  readonly themeName: string;
  readonly name: string;
  readonly body: string;
  readonly version: number;
  /**
   * True when the owning theme has `source = 'core'`: the template is our own code, so it
   * renders with the trusted time limit instead of the 50 ms budget for third-party themes.
   */
  readonly trusted: boolean;
}

/** A theme plus every template override on its chain (ADR 0008 parent fallback). */
export interface LoadedTheme {
  readonly theme: ThemeRecord;
  /** The theme first, then each ancestor up to the root. */
  readonly chain: readonly ThemeRecord[];
  /** Overrides per template name, leaf first: the first entry wins, the next is the fallback. */
  readonly templates: ReadonlyMap<string, readonly StoredThemeTemplate[]>;
}

interface ChainRow {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly parent_id: string | null;
  readonly source: string;
  readonly depth: number;
}

interface TemplateRow {
  readonly theme_id: string;
  readonly name: string;
  readonly body: string;
  readonly version: number;
}

/**
 * Loads a theme by name or ID with its ancestor chain and every override on that chain. The
 * recursive query stops on a cycle, so a corrupted parent link cannot hang a request.
 */
export async function loadTheme(sql: SQL, theme: string): Promise<LoadedTheme | null> {
  const chain = (await sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, name, version, parent_id, source, 0 AS depth, ARRAY[id] AS path
      FROM core.themes
      WHERE name = ${theme} OR id::text = ${theme}
      UNION ALL
      SELECT child.id, child.name, child.version, child.parent_id, child.source,
             ancestor.depth + 1, ancestor.path || child.id
      FROM core.themes AS child
      JOIN ancestors AS ancestor ON child.id = ancestor.parent_id
      WHERE NOT child.id = ANY(ancestor.path)
    )
    SELECT id::text AS id, name, version, parent_id::text AS parent_id, source, depth
    FROM ancestors
    ORDER BY depth
  `) as ChainRow[];

  const chainRecords = records(chain);
  const leaf = chainRecords[0];

  if (leaf === undefined) {
    return null;
  }

  const byId = new Map(chain.map((row) => [row.id, row]));
  const ids = chain.map((row) => row.id);
  const rows = (await sql`
    SELECT theme_id::text AS theme_id, name, body, version
    FROM core.theme_templates
    WHERE theme_id = ANY(${`{${ids.join(",")}}`}::bigint[])
    ORDER BY name
  `) as TemplateRow[];

  const templates = new Map<string, StoredThemeTemplate[]>();
  const sorted = [...rows].sort(
    (left, right) => (byId.get(left.theme_id)?.depth ?? 0) - (byId.get(right.theme_id)?.depth ?? 0),
  );

  for (const row of sorted) {
    const owner = byId.get(row.theme_id);

    if (owner === undefined) {
      continue;
    }

    const candidates = templates.get(row.name) ?? [];
    candidates.push({
      themeId: row.theme_id,
      themeName: owner.name,
      name: row.name,
      body: row.body,
      version: row.version,
      trusted: owner.source === "core",
    });
    templates.set(row.name, candidates);
  }

  return { theme: leaf, chain: chainRecords, templates };
}

function records(chain: readonly ChainRow[]): readonly ThemeRecord[] {
  return chain.map((row) => ({
    id: row.id,
    name: row.name,
    version: row.version,
    parentId: row.parent_id,
  }));
}

/** The overrides for one template name, leaf first. */
export function resolveTemplate(theme: LoadedTheme, name: string): readonly StoredThemeTemplate[] {
  return theme.templates.get(name) ?? [];
}
