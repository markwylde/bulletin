import type { Logger } from "@bulletin/config";
import { recomputeLeaderboards } from "@bulletin/domain/leaderboards";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

/** The hourly leaderboard recompute (design: hourly plus nightly; hourly covers both). */
export const LEADERBOARD_QUEUE = "leaderboards";
export const LEADERBOARD_CRON = "0 * * * *";

export interface LeaderboardJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly logger?: Logger;
}

export interface LeaderboardJobs {
  stop(): Promise<void>;
}

/** Registers the leaderboard queue and its hourly schedule (task 4.4). */
export async function createLeaderboardJobs(
  options: LeaderboardJobsOptions,
): Promise<LeaderboardJobs> {
  await ensurePgBossQueue(options.boss, LEADERBOARD_QUEUE);

  await options.boss.work(LEADERBOARD_QUEUE, async () => {
    const result = await recomputeLeaderboards(options.sql);
    options.logger?.info("leaderboards.recomputed", { rows: result.rows });
  });

  await options.boss.schedule(LEADERBOARD_QUEUE, LEADERBOARD_CRON, {});

  return {
    async stop() {
      await options.boss.offWork(LEADERBOARD_QUEUE);
    },
  };
}
