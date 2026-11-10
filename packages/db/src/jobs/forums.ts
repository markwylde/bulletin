import type { Logger } from "@bulletin/config";
import { flushRedirectClicks } from "@bulletin/domain/forums";
import { bumpAnnouncementTransitions } from "@bulletin/domain/permissions";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

/** Every minute: fold redirect clicks into forum counters (ADR 0006 read-path writes). */
export const FORUM_QUEUE = "forums";
export const FORUM_CRON = "* * * * *";

export interface ForumJobsResult {
  readonly redirectClicks: number;
  readonly announcementTags: readonly string[];
}

export interface ForumJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly logger?: Logger;
}

export interface ForumJobs {
  stop(): Promise<void>;
}

/** Registers the every-minute forum maintenance queue. */
export async function createForumJobs(options: ForumJobsOptions): Promise<ForumJobs> {
  await ensurePgBossQueue(options.boss, FORUM_QUEUE);

  await options.boss.work(FORUM_QUEUE, async () => {
    const result = await runForumJobs(options.sql);
    options.logger?.info("forums.completed", {
      redirectClicks: result.redirectClicks,
      announcementTags: result.announcementTags.join(" "),
    });
  });

  await options.boss.schedule(FORUM_QUEUE, FORUM_CRON, {});

  return {
    async stop() {
      await options.boss.offWork(FORUM_QUEUE);
    },
  };
}

export { bumpAnnouncementTransitions, flushRedirectClicks };

export async function runForumJobs(sql: SQL, now: Date = new Date()): Promise<ForumJobsResult> {
  return {
    redirectClicks: await flushRedirectClicks(sql),
    announcementTags: await bumpAnnouncementTransitions(sql, now),
  };
}
