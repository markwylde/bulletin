import { bumpCacheTags, memberTag } from "@bulletin/cache";
import type { Logger } from "@bulletin/config";
import { readBoardSettings } from "@bulletin/domain/board";
import {
  deleteReactionEntries,
  ensureRecountRun,
  finishRecountRun,
  lockReputationRebuild,
  markRecountRebuilt,
  nextMemberBatch,
  readRecountRun,
  rebuildReactionEntries,
  recomputeMemberBatch,
  reputationConfigHash,
  updateRecountProgress,
} from "@bulletin/domain/reputation";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";
import { evaluatePromotionInTransaction } from "./promotion.ts";

export const REPUTATION_RECOUNT_QUEUE = "reputation.recount";

/** Board recounts are idempotent and resumable; the default batch keeps transactions short. */
export const REPUTATION_RECOUNT_BATCH = 250;

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

export interface ReputationRecountResult {
  readonly runId: string;
  readonly changed: number;
  readonly processed: number;
  readonly total: number;
  readonly done: boolean;
}

/**
 * Rebuilds every reaction-sourced entry from the current board setting once, then recomputes
 * member totals in id-ordered batches. Progress lives in `core.reputation_recounts`, so a
 * retried job resumes from its cursor and the staff app can show the run (design risk:
 * "Toggling reactions on a big board").
 */
export async function runReputationRecount(
  sql: SQL,
  options: {
    readonly reason?: string;
    readonly batchSize?: number;
    /** Test seam: stop after this many member batches and leave the run open. */
    readonly maxBatches?: number;
    /** Test seam: replace the promotion evaluation committed with each batch. */
    readonly evaluatePromotion?: (tx: SQL, memberId: string) => Promise<unknown>;
  } = {},
): Promise<ReputationRecountResult> {
  const reason = options.reason ?? "manual";
  const batchSize = options.batchSize ?? REPUTATION_RECOUNT_BATCH;
  const promotionEvaluator = options.evaluatePromotion ?? evaluatePromotionInTransaction;
  let runId = "";

  await sql.begin(async (tx) => {
    await lockReputationRebuild(tx, "exclusive");
    const run = await ensureRecountRun(tx, reason);
    runId = run.id;
    const settings = await readBoardSettings(tx);
    const signature = await reputationConfigHash(tx, settings.reactionsAffectReputation);

    // A resumed run rebuilds again when the link or any weight changed since its last rebuild.
    if (run.rebuiltAt === null || run.configHash !== signature) {
      if (settings.reactionsAffectReputation) {
        await rebuildReactionEntries(tx);
      } else {
        await deleteReactionEntries(tx);
      }

      await markRecountRebuilt(tx, run.id, signature);
    }
  });

  const run = await readRecountRun(sql, runId);

  if (run === null) {
    throw new Error(`Missing the reputation recount run ${runId}`);
  }

  let cursor = run.cursorMemberId;
  let processed = run.processedMembers;
  let changed = run.changedMembers;
  let batches = 0;

  for (;;) {
    if (options.maxBatches !== undefined && batches >= options.maxBatches) {
      return { runId, changed, processed, total: run.totalMembers, done: false };
    }

    const ids = await nextMemberBatch(sql, cursor, batchSize);

    if (ids.length === 0) {
      await finishRecountRun(sql, runId);

      return { runId, changed, processed, total: run.totalMembers, done: true };
    }

    const last = ids[ids.length - 1] ?? cursor;

    const changes = await sql.begin(async (tx) => {
      const batch = await recomputeMemberBatch(tx, ids);

      // Reputation is a promotion criterion; a recount can push members over their threshold.
      // The promotions, their events and the cursor advance commit together, so a failed
      // evaluation retries the same batch instead of skipping it.
      for (const change of batch) {
        await bumpCacheTags(tx, [memberTag(change.memberId)]);
        await promotionEvaluator(tx, change.memberId);
      }

      await updateRecountProgress(tx, runId, {
        cursorMemberId: last,
        processed: ids.length,
        changed: batch.length,
      });

      return batch;
    });

    cursor = last;
    processed += ids.length;
    changed += changes.length;
    batches += 1;
  }
}

export async function createReputationJobs(
  options: ReputationJobsOptions,
): Promise<ReputationJobs> {
  await ensurePgBossQueue(options.boss, REPUTATION_RECOUNT_QUEUE, "standard");

  await options.boss.work<ReputationRecountPayload>(REPUTATION_RECOUNT_QUEUE, async (jobs) => {
    for (const job of jobs) {
      try {
        const result = await runReputationRecount(options.sql, {
          reason: job.data.reason ?? "board-setting",
        });
        options.logger?.info("reputation.recounted", {
          runId: result.runId,
          reason: job.data.reason ?? "board-setting",
          changed: result.changed,
          processed: result.processed,
          total: result.total,
        });

        if (!result.done) {
          await options.boss.send(
            REPUTATION_RECOUNT_QUEUE,
            { reason: job.data.reason ?? "board-setting" },
            { singletonKey: "reputation:recount" },
          );
        }
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
