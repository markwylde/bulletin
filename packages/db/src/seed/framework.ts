import type { SeedSize } from "@bulletin/config";
import type { StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import { createSeededRng } from "./rng.ts";

export interface SeedContext {
  readonly sql: SQL;
  readonly rng: () => number;
  readonly seed: number;
  readonly size: SeedSize;
  /** Present in local/dev apps; absent in pure database tests. */
  readonly storage?: StorageClient;
}

export interface SeedModule {
  readonly name: string;
  readonly dependsOn?: readonly string[];
  run(context: SeedContext): Promise<void>;
}

export interface SeedResult {
  readonly ran: boolean;
  readonly modules: readonly string[];
}

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedError";
  }
}

/** Orders modules so every dependency runs first and rejects missing dependencies/cycles. */
export function orderSeedModules(modules: readonly SeedModule[]): readonly SeedModule[] {
  const byName = new Map<string, SeedModule>();

  for (const module of modules) {
    if (byName.has(module.name)) {
      throw new SeedError(`Duplicate seed module ${module.name}`);
    }
    byName.set(module.name, module);
  }

  const ordered: SeedModule[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (module: SeedModule): void => {
    if (visited.has(module.name)) {
      return;
    }

    if (visiting.has(module.name)) {
      throw new SeedError(`Seed module dependency cycle at ${module.name}`);
    }

    visiting.add(module.name);

    for (const dependency of module.dependsOn ?? []) {
      const target = byName.get(dependency);

      if (target === undefined) {
        throw new SeedError(`Seed module ${module.name} depends on missing ${dependency}`);
      }

      visit(target);
    }

    visiting.delete(module.name);
    visited.add(module.name);
    ordered.push(module);
  };

  for (const module of modules) {
    visit(module);
  }

  return ordered;
}

export class SeedRegistry {
  readonly ordered: readonly SeedModule[];

  constructor(modules: readonly SeedModule[]) {
    this.ordered = orderSeedModules(modules);
  }
}

export interface RunSeedOptions {
  readonly sql: SQL;
  readonly registry: SeedRegistry;
  readonly seed?: number;
  readonly size?: SeedSize;
  readonly storage?: StorageClient;
}

/**
 * Runs every registered module in one transaction, guarded by `core.seed_runs`.
 * A rerun on a seeded database is a no-op; a failed seed rolls back completely.
 */
export async function runSeeds(options: RunSeedOptions): Promise<SeedResult> {
  if (options.registry.ordered.length === 0) {
    return { ran: false, modules: [] };
  }

  const seed = options.seed ?? 42;
  const size = options.size ?? "default";
  const rng = createSeededRng(seed);
  let ran = false;

  await options.sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('bulletin.seed'))`;

    const existing = (await tx`SELECT 1 FROM core.seed_runs LIMIT 1`) as unknown[];

    if (existing.length > 0) {
      return;
    }

    for (const module of options.registry.ordered) {
      await module.run({
        sql: tx,
        rng,
        seed,
        size,
        ...(options.storage === undefined ? {} : { storage: options.storage }),
      });
    }

    for (const module of options.registry.ordered) {
      await tx`
        INSERT INTO core.seed_runs (name, seed, size)
        VALUES (${module.name}, ${seed}, ${size})
      `;
    }

    ran = true;
  });

  return {
    ran,
    modules: ran ? options.registry.ordered.map((module) => module.name) : [],
  };
}
