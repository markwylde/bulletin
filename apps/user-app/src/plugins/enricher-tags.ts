import type { SQL } from "bun";

/** Dependency tags declared by enrichers, known before the cache captures versions. */
export async function loadEnricherTags(sql: SQL, hook: string): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT plugin_id, definition->'deps' AS deps
    FROM core.plugin_registry
    WHERE kind = 'enricher' AND key = ${hook}
    ORDER BY plugin_id
  `) as Array<{ plugin_id: string; deps: unknown }>;
  const tags = new Set<string>();

  for (const row of rows) {
    if (Array.isArray(row.deps)) {
      for (const dep of row.deps) {
        if (typeof dep === "string" && dep !== "") {
          tags.add(`plugin:${row.plugin_id}:${dep}`);
        }
      }
    }
  }

  return [...tags].sort();
}
