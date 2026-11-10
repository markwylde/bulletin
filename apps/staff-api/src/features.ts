import { loadFlagViewer, loadStoredFlags } from "@bulletin/db/flags";
import { evaluateFlag } from "@bulletin/flags";
import type { SQL } from "bun";

/** Client-visible flags for the signed-in staff member (ADR 0010). */
export async function staffFeatureFlags(
  sql: SQL,
  memberId: string,
): Promise<Readonly<Record<string, boolean>>> {
  const [definitions, viewer] = await Promise.all([
    loadStoredFlags(sql),
    loadFlagViewer(sql, memberId),
  ]);
  const flags: Record<string, boolean> = {};

  for (const definition of definitions) {
    if (definition.clientVisible) {
      flags[definition.key] = evaluateFlag(definition, viewer);
    }
  }

  return flags;
}

/** One server-side flag guard for the staff API; unknown or disabled flags fail closed. */
export async function staffFlagEnabled(sql: SQL, memberId: string, key: string): Promise<boolean> {
  return (await staffFeatureFlags(sql, memberId))[key] === true;
}
