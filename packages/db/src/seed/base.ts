import type { SeedSize } from "@bulletin/config";
import { SQL } from "bun";
import { runSeeds, type SeedModule, SeedRegistry, type SeedResult } from "./framework.ts";

export const baseSeedModule: SeedModule = {
  name: "base",
  async run({ sql }) {
    await sql`
      INSERT INTO core.board_settings (id, board_name, board_description)
      VALUES (1, 'Bulletin', '')
      ON CONFLICT (id) DO NOTHING
    `;
  },
};

function seedSize(): SeedSize {
  const value = Bun.env.SEED_SIZE;
  return value === "small" || value === "large" ? value : "default";
}

/** Runs the foundation's base seed modules against a database after migrations. */
export async function runBaseSeedFromEnv(databaseUrl: string): Promise<SeedResult> {
  const sql = new SQL(databaseUrl);

  try {
    return await runSeeds({
      sql,
      registry: new SeedRegistry([baseSeedModule]),
      seed: Number(Bun.env.SEED ?? 42),
      size: seedSize(),
    });
  } finally {
    await sql.close();
  }
}
