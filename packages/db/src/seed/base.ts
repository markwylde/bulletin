import type { SeedSize } from "@bulletin/config";
import { SQL } from "bun";
import { runSeeds, type SeedModule, SeedRegistry, type SeedResult } from "./framework.ts";
import { membersSeedModule } from "./members.ts";

export const baseSeedModule: SeedModule = {
  name: "base",
  async run({ sql }) {
    await sql`
      INSERT INTO core.board_settings (id, board_name, board_description, default_locale)
      VALUES (1, 'Bulletin', '', 'en')
      ON CONFLICT (id) DO NOTHING
    `;
  },
};

function seedSize(): SeedSize {
  const value = Bun.env.SEED_SIZE;
  return value === "small" || value === "large" ? value : "default";
}

export interface BaseSeedOptions {
  readonly databaseUrl: string;
  readonly seed?: number;
  readonly size?: SeedSize;
}

/** Runs the foundation's base seed modules against a database after migrations. */
export async function runBaseSeed(options: BaseSeedOptions): Promise<SeedResult> {
  const sql = new SQL(options.databaseUrl, { connectionTimeout: 5 });

  try {
    return await runSeeds({
      sql,
      registry: new SeedRegistry([baseSeedModule, membersSeedModule]),
      seed: options.seed ?? 42,
      size: options.size ?? "default",
    });
  } finally {
    await sql.close();
  }
}

/** Runs the foundation's base seed modules against a database after migrations. */
export async function runBaseSeedFromEnv(databaseUrl: string): Promise<SeedResult> {
  return runBaseSeed({
    databaseUrl,
    seed: Number(Bun.env.SEED ?? 42),
    size: seedSize(),
  });
}
