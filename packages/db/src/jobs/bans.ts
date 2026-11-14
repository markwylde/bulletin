import type { Logger } from "@bulletin/config";
import { restoreExpiredMemberBans } from "@bulletin/domain/bans";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

export const MEMBER_BAN_RESTORE_QUEUE = "ban.restore";
export const MEMBER_BAN_RESTORE_CRON = "*/10 * * * *";

export interface BanJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly logger?: Logger;
}

export interface BanJobs {
  stop(): Promise<void>;
}

export async function createBanJobs(options: BanJobsOptions): Promise<BanJobs> {
  await ensurePgBossQueue(options.boss, MEMBER_BAN_RESTORE_QUEUE);

  await options.boss.work(MEMBER_BAN_RESTORE_QUEUE, async () => {
    const restored = await restoreExpiredMemberBans(options.sql);
    options.logger?.info("ban.restore", { restored });
  });

  await options.boss.schedule(MEMBER_BAN_RESTORE_QUEUE, MEMBER_BAN_RESTORE_CRON, {});

  return {
    async stop() {
      await options.boss.offWork(MEMBER_BAN_RESTORE_QUEUE);
    },
  };
}
