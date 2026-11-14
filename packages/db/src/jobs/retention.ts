import type { Logger } from "@bulletin/config";
import { clearExpiredExport, purgeExpiredPii, readExpiredExports } from "@bulletin/domain/pii";
import { purgeExpiredCoreRetention, readPrivacySettings } from "@bulletin/domain/privacy";
import type { StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

/** Nightly: purge every expired personal-data category (ADR 0012). */
export const RETENTION_QUEUE = "privacy.retention";
export const RETENTION_CRON = "17 3 * * *";

export interface RetentionResult {
  readonly postIps: number;
  readonly loginIps: number;
  readonly accessLog: number;
  readonly sessionMeta: number;
  readonly revokedSessions: number;
  readonly ipBans: number;
  readonly exportsDeleted: number;
  readonly exportFailures: number;
}

export interface RetentionOptions {
  /** Test seam: the clock used by every cutoff. */
  readonly now?: Date;
}

/**
 * Deletes expired export objects first, then clears their metadata. A storage failure leaves
 * the request row intact, so the next nightly run retries the object instead of losing the key.
 */
async function purgeExports(
  sql: SQL,
  storage: StorageClient,
  now: Date,
): Promise<{ deleted: number; failures: number }> {
  const expired = await readExpiredExports(sql, now);
  let deleted = 0;
  let failures = 0;

  for (const entry of expired) {
    try {
      await storage.delete(entry.exportKey);
    } catch {
      failures += 1;
      continue;
    }

    if (await clearExpiredExport(sql, entry.requestId, now)) {
      deleted += 1;
    }
  }

  return { deleted, failures };
}

/** The retention sweep itself, so the scheduled job and tests share one implementation. */
export async function runRetention(
  sql: SQL,
  storage: StorageClient,
  options: RetentionOptions = {},
): Promise<RetentionResult> {
  const now = options.now ?? new Date();
  const settings = await readPrivacySettings(sql);
  const exports = await purgeExports(sql, storage, now);
  const pii = await purgeExpiredPii(sql, now);
  const core = await purgeExpiredCoreRetention(sql, settings, now);

  return {
    ...pii,
    ...core,
    exportsDeleted: exports.deleted,
    exportFailures: exports.failures,
  };
}

export interface RetentionJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly storage: StorageClient;
  readonly logger?: Logger;
}

export interface RetentionJobs {
  stop(): Promise<void>;
}

/** Registers the nightly retention queue (ADR 0012, ADR 0011). */
export async function createRetentionJobs(options: RetentionJobsOptions): Promise<RetentionJobs> {
  await ensurePgBossQueue(options.boss, RETENTION_QUEUE);

  await options.boss.work(RETENTION_QUEUE, async () => {
    const result = await runRetention(options.sql, options.storage);
    options.logger?.info("privacy.retention.completed", Object.fromEntries(Object.entries(result)));
  });

  await options.boss.schedule(RETENTION_QUEUE, RETENTION_CRON, {});

  return {
    async stop() {
      await options.boss.offWork(RETENTION_QUEUE);
    },
  };
}
