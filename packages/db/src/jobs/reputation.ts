import type { Logger } from "@bulletin/config";
import { readBoardSettings } from "@bulletin/domain/board";
import { rebuildReactionReputation } from "@bulletin/domain/reputation";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

export const REPUTATION_RECOUNT_QUEUE = "reputation.recount";

export interface ReputationRecountPayload {
  readonly reason?: string;
}

export interface ReputationJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly logger?: Logger;
}

export interface ReputationJobs {
  stop(): Promise<void>;
}

/**
 * Rebuilds every reaction-sourced entry from the current board setting and reactions, then
 * recomputes all member totals and bumps the cards that changed (design: the reaction link's
 * recount). Idempotent, so a retried job is safe.
 */
export async function runReputationRecount(sql: SQL): Promise<{ readonly changed: number }> {
  const settings = await readBoardSettings(sql);
  const changed = await rebuildReactionReputation(sql, {
    enabled: settings.reactionsAffectReputation,
  });

  return { changed: changed.length };
}

export async function createReputationJobs(
  options: ReputationJobsOptions,
): Promise<ReputationJobs> {
  await ensurePgBossQueue(options.boss, REPUTATION_RECOUNT_QUEUE, "standard");

  await options.boss.work<ReputationRecountPayload>(REPUTATION_RECOUNT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      try {
        const result = await runReputationRecount(options.sql);
        options.logger?.info("reputation.recounted", {
          reason: job.data.reason ?? "manual",
          changed: result.changed,
        });
      } catch (error) {
        options.logger?.error("reputation.recount.failed", { error });
        throw error;
      }
    }
  });

  return {
    async stop() {
      await options.boss.offWork(REPUTATION_RECOUNT_QUEUE);
    },
  };
}
