import type { SQL } from "bun";

/**
 * Advances `pluginsGeneration` and copies the current active fragment snapshot to the new
 * generation. Disabling one plugin therefore cannot erase another plugin's fragments, and a
 * settings change invalidates cached pages without dropping unrelated hooks.
 */
export async function advancePluginsGenerationInTransaction(tx: SQL): Promise<number> {
  const rows = (await tx`
      UPDATE core.plugin_generation
      SET generation = generation + 1, updated_at = now()
      WHERE id = true
      RETURNING generation
    `) as Array<{ generation: number }>;
  const next = rows[0]?.generation;

  if (next === undefined) {
    return 1;
  }

  await tx`
      INSERT INTO core.hook_fragments (generation, name, body, plugin_id, kind)
      SELECT ${next}, name, body, plugin_id, kind
      FROM core.hook_fragments
      WHERE generation = ${next - 1}
      ON CONFLICT DO NOTHING
    `;
  await tx`
      DELETE FROM core.hook_fragments WHERE generation < ${next}
    `;

  return next;
}

export async function advancePluginsGeneration(sql: SQL): Promise<number> {
  return sql.begin((tx) => advancePluginsGenerationInTransaction(tx));
}
