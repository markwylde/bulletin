import type { Logger } from "@bulletin/config";
import { forwardSystemAudits } from "@bulletin/domain/audit";
import { purgeExpiredDrafts } from "@bulletin/domain/content";
import { closePollTransitions } from "@bulletin/domain/polls";
import { flushTopicViews, purgeExpiredTopicStubs } from "@bulletin/domain/topics";
import { expireVisitBuffers } from "@bulletin/domain/visits";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

/** Every minute: drain the audit buffer and expire derived visit rows (ADR 0012). */
export const MAINTENANCE_QUEUE = "maintenance";
export const MAINTENANCE_CRON = "* * * * *";

export interface MaintenanceResult {
  readonly forwardedAudits: number;
  readonly expiredPresence: number;
  readonly expiredViews: number;
  readonly expiredDrafts: number;
  readonly flushedTopicViews: number;
  readonly expiredTopicStubs: number;
  readonly closedPolls: number;
}

export interface MaintenanceOptions {
  /** Test seam: the clock used to expire view buckets. */
  readonly now?: Date;
}

/** The maintenance sweep itself, so tests and the scheduled job share one implementation. */
export async function runMaintenance(
  sql: SQL,
  options: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const [audits, drafts] = await Promise.all([forwardSystemAudits(sql), purgeExpiredDrafts(sql)]);
  // Count views before expiring their buckets. A view late in a bucket (12:29:59) still
  // belongs to it, and expiry must never drop a view that was not counted (reviewer finding).
  const topicViews = await flushTopicViews(sql);
  const visits = await expireVisitBuffers(sql, options);
  const topicStubs = await purgeExpiredTopicStubs(sql);
  const closedPolls = await closePollTransitions(sql);

  return {
    forwardedAudits: audits.forwarded,
    expiredPresence: visits.presence,
    expiredViews: visits.views,
    expiredDrafts: drafts,
    flushedTopicViews: topicViews,
    expiredTopicStubs: topicStubs,
    closedPolls,
  };
}

export interface MaintenanceJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly logger?: Logger;
}

export interface MaintenanceJobs {
  stop(): Promise<void>;
}

/** Registers the maintenance queue and its every-minute schedule (ADR 0012). */
export async function createMaintenanceJobs(
  options: MaintenanceJobsOptions,
): Promise<MaintenanceJobs> {
  await ensurePgBossQueue(options.boss, MAINTENANCE_QUEUE);

  await options.boss.work(MAINTENANCE_QUEUE, async () => {
    const result = await runMaintenance(options.sql);
    options.logger?.info("maintenance.completed", {
      forwardedAudits: result.forwardedAudits,
      expiredPresence: result.expiredPresence,
      expiredViews: result.expiredViews,
      expiredDrafts: result.expiredDrafts,
      flushedTopicViews: result.flushedTopicViews,
      expiredTopicStubs: result.expiredTopicStubs,
      closedPolls: result.closedPolls,
    });
  });

  await options.boss.schedule(MAINTENANCE_QUEUE, MAINTENANCE_CRON, {});

  return {
    async stop() {
      await options.boss.offWork(MAINTENANCE_QUEUE);
    },
  };
}
