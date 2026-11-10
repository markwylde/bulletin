import type { SQL } from "bun";

interface HookRow {
  readonly name: string;
  readonly body: string;
}

/**
 * Plugin-style hook fragments for a plugin generation (ADR 0008, 0009). Spike S1 scaffolding:
 * the `plugin-platform` change serves these from the sandbox's registered fragments.
 */
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
