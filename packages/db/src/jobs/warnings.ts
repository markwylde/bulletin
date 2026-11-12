import type { Logger } from "@bulletin/config";
import { expireWarnings } from "@bulletin/domain/warnings";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

/** Hourly: stamp warnings whose expiry passed. Active points already ignore them. */
export const WARNING_EXPIRY_QUEUE = "warning.expiry";
export const WARNING_EXPIRY_CRON = "7 * * * *";

export interface WarningJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly logger?: Logger;
}

export interface WarningJobs {
  stop(): Promise<void>;
}

export async function createWarningJobs(options: WarningJobsOptions): Promise<WarningJobs> {
  await ensurePgBossQueue(options.boss, WARNING_EXPIRY_QUEUE);

  await options.boss.work(WARNING_EXPIRY_QUEUE, async () => {
    const expired = await expireWarnings(options.sql);
    options.logger?.info("warning.expiry", { expired });
  });

  await options.boss.schedule(WARNING_EXPIRY_QUEUE, WARNING_EXPIRY_CRON, {});

  return {
    async stop() {
      await options.boss.offWork(WARNING_EXPIRY_QUEUE);
    },
  };
}
