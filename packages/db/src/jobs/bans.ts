import type { Logger } from "@bulletin/config";
import { restoreExpiredMemberBans } from "@bulletin/domain/bans";
import { purgeExpiredPii } from "@bulletin/domain/pii";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

export const MEMBER_BAN_RESTORE_QUEUE = "ban.restore";
export const MEMBER_BAN_RESTORE_CRON = "*/10 * * * *";
export const PII_PURGE_QUEUE = "pii.purge";
export const PII_PURGE_CRON = "17 3 * * *";

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
  await ensurePgBossQueue(options.boss, PII_PURGE_QUEUE);

  await options.boss.work(MEMBER_BAN_RESTORE_QUEUE, async () => {
    const restored = await restoreExpiredMemberBans(options.sql);
    options.logger?.info("ban.restore", { restored });
  });

  await options.boss.work(PII_PURGE_QUEUE, async () => {
    const purged = await purgeExpiredPii(options.sql);
    options.logger?.info("pii.purge", purged);
  });

  await options.boss.schedule(MEMBER_BAN_RESTORE_QUEUE, MEMBER_BAN_RESTORE_CRON, {});
  await options.boss.schedule(PII_PURGE_QUEUE, PII_PURGE_CRON, {});

  return {
    async stop() {
      await options.boss.offWork(MEMBER_BAN_RESTORE_QUEUE);
      await options.boss.offWork(PII_PURGE_QUEUE);
    },
  };
}
