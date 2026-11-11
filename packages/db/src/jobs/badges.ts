import type { Logger } from "@bulletin/config";
import { evaluateAllBadgeRules } from "@bulletin/domain/badges";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

export const BADGE_SWEEP_QUEUE = "badges.sweep";
export const BADGE_SWEEP_CRON = "0 3 * * *";

export interface BadgeJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly logger?: Logger;
}

export interface BadgeJobs {
  stop(): Promise<void>;
}

/** Registers the nightly badge-rule sweep (task 5.4). */
export async function createBadgeJobs(options: BadgeJobsOptions): Promise<BadgeJobs> {
  await ensurePgBossQueue(options.boss, BADGE_SWEEP_QUEUE);

  await options.boss.work(BADGE_SWEEP_QUEUE, async () => {
    const awarded = await evaluateAllBadgeRules(options.sql);
    options.logger?.info("badges.swept", { awarded });
  });

  await options.boss.schedule(BADGE_SWEEP_QUEUE, BADGE_SWEEP_CRON, {});

  return {
    async stop() {
      await options.boss.offWork(BADGE_SWEEP_QUEUE);
    },
  };
}
