import type { Logger } from "@bulletin/config";
import {
  ATTACHMENT_PROCESS_CHANNEL,
  type AttachmentScan,
  claimExpiredAttachments,
  flushAttachmentDownloadBuffer,
  isAttachmentContentType,
  listAttachmentKeys,
  listProcessableAttachments,
  publishAttachment,
  readAttachmentById,
  readUploadLimits,
  rejectAttachment,
  sha256Hex,
} from "@bulletin/domain/attachments";
import {
  AttachmentProcessingError,
  processAttachmentBytes,
} from "@bulletin/domain/attachments/processing";
import {
  finishAvatarDeletion,
  listAvatarDeletions,
  markAvatarDeletionFailed,
  readMemberAvatar,
  withAvatarObjectLock,
} from "@bulletin/domain/member";
import {
  type AttachmentRecord,
  AVATAR_VARIANTS,
  attachmentKey,
  avatarKey,
  isManagedKey,
  type StorageClient,
  thumbnailKeyFor,
  transitionAttachment,
} from "@bulletin/storage";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";
import { listUnfurlImageKeys } from "./unfurl-images.ts";

/** Every minute: publish snapshotted uploads. A five-field cron is what pg-boss schedules. */
export const ATTACHMENT_PROCESS_QUEUE = "attachment.process";
export const ATTACHMENT_PROCESS_CRON = "* * * * *";
/** Hourly: delete uploads nobody attached within 24 hours, releasing their quota. */
export const ATTACHMENT_ORPHAN_QUEUE = "attachment.orphans";
export const ATTACHMENT_ORPHAN_CRON = "41 * * * *";
/** Weekly: remove bucket objects with no attachment row (ADR 0019). */
export const ATTACHMENT_RECONCILE_QUEUE = "attachment.reconcile";
export const ATTACHMENT_RECONCILE_CRON = "23 4 * * 0";

export interface ProcessAttachmentOptions {
  readonly scan?: AttachmentScan;
  readonly logger?: Logger;
}

export type ProcessAttachmentResult =
  | { readonly kind: "ready"; readonly attachment: AttachmentRecord }
  | { readonly kind: "rejected"; readonly attachment: AttachmentRecord }
  | { readonly kind: "missing" }
  | { readonly kind: "skipped" };

/** Every object key that belongs to one attachment row. */
export function attachmentObjectKeys(record: AttachmentRecord): readonly string[] {
  const keys = [record.quarantineKey, record.snapshotKey, record.storageKey];

  if (record.storageKey !== null) {
    keys.push(thumbnailKeyFor(record.storageKey));
  }

  return keys.filter((key): key is string => key !== null);
}

async function reject(
  sql: SQL,
  storage: StorageClient,
  record: AttachmentRecord,
  code: string,
  options: ProcessAttachmentOptions,
): Promise<ProcessAttachmentResult> {
  const rejected = await rejectAttachment(sql, record, code);

  if (rejected === null) {
    return { kind: "skipped" };
  }

  if (record.snapshotKey !== null) {
    await storage.delete(record.snapshotKey).catch((error: unknown) => {
      options.logger?.warn("attachment.snapshot_cleanup_failed", {
        attachmentId: record.id,
        error,
      });
    });
  }

  options.logger?.info("attachment.rejected", { attachmentId: record.id, code });

  return { kind: "rejected", attachment: rejected };
}

/**
 * Processes one attachment from its immutable snapshot: verifies the checksum, sniffs the
 * content, re-encodes images (stripping metadata), runs the optional scan hook, publishes the
 * final object and marks the row ready. Rejections release quota; transient failures throw so
 * the sweep retries after the stale-processing window.
 */
export async function processAttachment(
  sql: SQL,
  storage: StorageClient,
  id: string,
  options: ProcessAttachmentOptions = {},
): Promise<ProcessAttachmentResult> {
  const current = await readAttachmentById(sql, id);

  if (current === null) {
    return { kind: "missing" };
  }

  let record = current;

  if (record.state === "snapshotted") {
    const claimed = await transitionAttachment(sql, {
      id: record.id,
      from: "snapshotted",
      to: "processing",
    });

    if (claimed === null) {
      return { kind: "skipped" };
    }

    record = claimed;
  } else if (record.state !== "processing") {
    return { kind: "skipped" };
  }

  if (record.snapshotKey === null || record.sha256 === null) {
    return reject(sql, storage, record, "snapshot_missing", options);
  }

  if (!isAttachmentContentType(record.declaredType)) {
    return reject(sql, storage, record, "type_not_allowed", options);
  }

  if (!(await storage.exists(record.snapshotKey))) {
    return reject(sql, storage, record, "snapshot_missing", options);
  }

  const snapshot = await storage.get(record.snapshotKey);

  if (sha256Hex(snapshot) !== record.sha256) {
    return reject(sql, storage, record, "checksum_mismatch", options);
  }

  let processed: Awaited<ReturnType<typeof processAttachmentBytes>>;

  try {
    processed = await processAttachmentBytes(snapshot, record.declaredType);
  } catch (error) {
    if (!(error instanceof AttachmentProcessingError)) {
      throw error;
    }

    return reject(sql, storage, record, error.code, options);
  }

  // The declared type was checked at upload time, but the sniffed input type is the truth.
  // Re-check it against the member's current group/board allowlist before publishing.
  const limits = await readUploadLimits(sql, record.memberId);

  if (!limits.allowedTypes.includes(processed.sourceType)) {
    return reject(sql, storage, record, "type_not_allowed", options);
  }

  const publishedBytes = processed.bytes ?? snapshot;

  if (options.scan !== undefined) {
    const verdict = await options.scan({
      bytes: publishedBytes,
      contentType: processed.contentType,
    });

    if (verdict === "infected") {
      return reject(sql, storage, record, "malware_detected", options);
    }
  }

  const finalKey = attachmentKey(crypto.randomUUID());

  if (processed.bytes === undefined) {
    await storage.copy(record.snapshotKey, finalKey);
  } else {
    await storage.put(finalKey, processed.bytes, { contentType: processed.contentType });
  }

  if (processed.thumbnail !== undefined) {
    await storage.put(thumbnailKeyFor(finalKey), processed.thumbnail, {
      contentType: "image/webp",
    });
  }

  const published = await publishAttachment(sql, record, {
    storageKey: finalKey,
    sizeBytes: publishedBytes.byteLength,
    sha256: sha256Hex(publishedBytes),
    verifiedType: processed.contentType,
    quotaBytes: limits.quotaBytes,
  });

  if (published.kind === "skipped") {
    return { kind: "skipped" };
  }

  if (published.kind === "quota_exceeded") {
    // Processing grew the file past what the member may store: drop what this run wrote.
    for (const key of [finalKey, thumbnailKeyFor(finalKey)]) {
      await storage.delete(key).catch((error: unknown) => {
        options.logger?.warn("attachment.published_cleanup_failed", {
          attachmentId: record.id,
          key,
          error,
        });
      });
    }

    await storage.delete(record.snapshotKey).catch((error: unknown) => {
      options.logger?.warn("attachment.snapshot_cleanup_failed", {
        attachmentId: record.id,
        error,
      });
    });
    options.logger?.info("attachment.rejected", {
      attachmentId: record.id,
      code: published.attachment.rejectionCode,
    });

    return { kind: "rejected", attachment: published.attachment };
  }

  await storage.delete(record.snapshotKey).catch((error: unknown) => {
    options.logger?.warn("attachment.snapshot_cleanup_failed", {
      attachmentId: record.id,
      error,
    });
  });
  options.logger?.info("attachment.ready", {
    attachmentId: record.id,
    contentType: processed.contentType,
    sizeBytes: publishedBytes.byteLength,
  });

  return { kind: "ready", attachment: published.attachment };
}

export interface AvatarDeletionResult {
  readonly deleted: number;
  readonly failed: number;
}

/**
 * Retries persisted avatar-object deletions; old URLs are already blocked by the hash check.
 * The check and the object deletion run under the member's avatar object lock so a concurrent
 * re-upload of the same hash cannot be published and then have its objects deleted.
 */
export async function processAvatarDeletions(
  sql: SQL,
  storage: StorageClient,
  options: { readonly limit?: number; readonly logger?: Logger } = {},
): Promise<AvatarDeletionResult> {
  const pending = await listAvatarDeletions(sql, options.limit ?? 50);
  let deleted = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const current = await withAvatarObjectLock(sql, row.memberId, async (tx) => {
        const avatar = await readMemberAvatar(tx, row.memberId);

        if (avatar?.hash === row.avatarHash) {
          await finishAvatarDeletion(tx, row.memberId, row.avatarHash);
          return "kept" as const;
        }

        await Promise.all(
          AVATAR_VARIANTS.map((variant) =>
            storage.delete(avatarKey(row.memberId, row.avatarHash, variant)),
          ),
        );
        await finishAvatarDeletion(tx, row.memberId, row.avatarHash);
        return "deleted" as const;
      });

      if (current === "deleted") {
        deleted += 1;
      }
    } catch (error) {
      failed += 1;
      await markAvatarDeletionFailed(sql, row.memberId, row.avatarHash).catch(() => undefined);
      options.logger?.warn("avatar.deletion_failed", {
        memberId: row.memberId,
        avatarHash: row.avatarHash,
        error,
      });
    }
  }

  return { deleted, failed };
}

export interface AttachmentProcessingResult {
  readonly processed: number;
  readonly rejected: number;
  readonly failed: number;
  readonly avatarDeletions: AvatarDeletionResult;
  readonly downloadsFlushed: number;
}

/** One sweep of the snapshotted/stale-processing queue. */
export async function runAttachmentProcessing(
  sql: SQL,
  storage: StorageClient,
  options: ProcessAttachmentOptions & { readonly limit?: number } = {},
): Promise<AttachmentProcessingResult> {
  const [downloadsFlushed, avatarDeletions] = await Promise.all([
    flushAttachmentDownloadBuffer(sql).catch((error: unknown) => {
      options.logger?.error("attachment.download_flush_failed", { error });
      return 0;
    }),
    processAvatarDeletions(sql, storage, {
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }),
  ]);
  const rows = await listProcessableAttachments(sql, {
    limit: options.limit ?? 20,
  });
  let processed = 0;
  let rejected = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const result = await processAttachment(sql, storage, row.id, options);

      if (result.kind === "ready") {
        processed += 1;
      } else if (result.kind === "rejected") {
        rejected += 1;
      }
    } catch (error) {
      failed += 1;
      options.logger?.error("attachment.processing_failed", {
        attachmentId: row.id,
        error,
      });
    }
  }

  return { processed, rejected, failed, avatarDeletions, downloadsFlushed };
}

export interface AttachmentSweepOptions {
  readonly now?: Date;
  readonly limit?: number;
  readonly logger?: Logger;
}

export interface AttachmentSweepResult {
  readonly deleted: number;
}

/** Deletes expired unattached attachments and every object they own, then releases quota. */
export async function runAttachmentOrphanSweep(
  sql: SQL,
  storage: StorageClient,
  options: AttachmentSweepOptions = {},
): Promise<AttachmentSweepResult> {
  const expired = await claimExpiredAttachments(
    sql,
    options.now ?? new Date(),
    options.limit ?? 200,
  );

  for (const record of expired) {
    for (const key of attachmentObjectKeys(record)) {
      await storage.delete(key).catch((error: unknown) => {
        options.logger?.warn("attachment.orphan_object_failed", {
          attachmentId: record.id,
          key,
          error,
        });
      });
    }
  }

  const deleted = expired.length;

  if (deleted > 0) {
    options.logger?.info("attachment.orphans_deleted", { deleted });
  }

  return { deleted };
}

export interface AttachmentReconcileOptions {
  readonly logger?: Logger;
  /** Overridable for tests; defaults to now. */
  readonly now?: Date;
  /** Objects written this recently may be waiting for their database commit. */
  readonly graceMs?: number;
}

const RECONCILE_GRACE_MS = 15 * 60 * 1_000;

async function listAvatarObjectKeys(sql: SQL): Promise<readonly string[]> {
  const rows = (await sql`
    SELECT id::text AS member_id, avatar_hash
    FROM core.members
    WHERE avatar_hash IS NOT NULL
  `) as Array<{ member_id: string; avatar_hash: string }>;

  return rows.flatMap((row) =>
    AVATAR_VARIANTS.map((variant) => avatarKey(row.member_id, row.avatar_hash, variant)),
  );
}

function liveAttachmentKeys(
  rows: Awaited<ReturnType<typeof listAttachmentKeys>>,
  unfurlKeys: readonly string[],
): Set<string> {
  const live = new Set<string>(unfurlKeys);

  for (const row of rows) {
    // A quarantine key is only authoritative while the upload is still pending; after
    // finalisation any object under it is a replay and is removed.
    if (row.state === "pending") {
      live.add(row.quarantine_key);
    }

    if (row.snapshot_key !== null && (row.state === "snapshotted" || row.state === "processing")) {
      live.add(row.snapshot_key);
    }

    if (row.storage_key !== null && row.state === "ready") {
      live.add(row.storage_key);
      live.add(thumbnailKeyFor(row.storage_key));
    }
  }

  return live;
}

/**
 * Removes `att/`, `quarantine/` and `processing/` objects with no authoritative row. Objects
 * younger than the grace period are left for the next run (they may be between an object write
 * and its database commit), and the key set is re-read after the grace filter before deleting.
 */
export async function runAttachmentReconciliation(
  sql: SQL,
  storage: StorageClient,
  options: AttachmentReconcileOptions = {},
): Promise<AttachmentSweepResult> {
  const objects = await storage.list("");
  const cutoff = (options.now ?? new Date()).getTime() - (options.graceMs ?? RECONCILE_GRACE_MS);
  const candidates = objects.filter((object) => {
    const isAttachmentKey =
      object.key.startsWith("att/") ||
      object.key.startsWith("quarantine/") ||
      object.key.startsWith("processing/") ||
      object.key.startsWith("unfurl/");

    return (
      (isAttachmentKey || object.key.startsWith("av/")) &&
      isManagedKey(object.key) &&
      object.lastModified.getTime() <= cutoff
    );
  });

  if (candidates.length === 0) {
    return { deleted: 0 };
  }

  // Revalidate after listing: a row committed since the object listing must win.
  const [rows, unfurlKeys, avatarKeys] = await Promise.all([
    listAttachmentKeys(sql),
    listUnfurlImageKeys(sql),
    listAvatarObjectKeys(sql),
  ]);
  const live = liveAttachmentKeys(rows, unfurlKeys);

  for (const key of avatarKeys) {
    live.add(key);
  }
  let deleted = 0;

  for (const object of candidates) {
    if (live.has(object.key)) {
      continue;
    }

    try {
      await storage.delete(object.key);
      deleted += 1;
    } catch (error) {
      options.logger?.warn("attachment.reconcile_object_failed", { key: object.key, error });
    }
  }

  if (deleted > 0) {
    options.logger?.info("attachment.reconciled", { deleted });
  }

  return { deleted };
}

export interface AttachmentJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  /**
   * The direct connection for LISTEN (ADR 0003); defaults to `sql`. Must not be a
   * transaction-mode pooler, which drops LISTEN state between transactions.
   */
  readonly listenSql?: SQL;
  readonly storage: StorageClient;
  readonly logger?: Logger;
  readonly scan?: AttachmentScan;
  readonly now?: () => Date;
}

export interface AttachmentJobs {
  stop(): Promise<void>;
}

/** Registers the processing, orphan and reconciliation queues (ADR 0011, 0019). */
export async function createAttachmentJobs(
  options: AttachmentJobsOptions,
): Promise<AttachmentJobs> {
  const now = options.now ?? (() => new Date());

  await ensurePgBossQueue(options.boss, ATTACHMENT_PROCESS_QUEUE);
  await ensurePgBossQueue(options.boss, ATTACHMENT_ORPHAN_QUEUE);
  await ensurePgBossQueue(options.boss, ATTACHMENT_RECONCILE_QUEUE);

  await options.boss.work(ATTACHMENT_PROCESS_QUEUE, async () => {
    const result = await runAttachmentProcessing(options.sql, options.storage, {
      ...(options.scan === undefined ? {} : { scan: options.scan }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    options.logger?.info("attachment.process_sweep", { ...result });
  });

  await options.boss.work(ATTACHMENT_ORPHAN_QUEUE, async () => {
    const result = await runAttachmentOrphanSweep(options.sql, options.storage, {
      now: now(),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    options.logger?.info("attachment.orphan_sweep", { ...result });
  });

  await options.boss.work(ATTACHMENT_RECONCILE_QUEUE, async () => {
    const result = await runAttachmentReconciliation(options.sql, options.storage, {
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    options.logger?.info("attachment.reconcile_sweep", { ...result });
  });

  await options.boss.schedule(ATTACHMENT_PROCESS_QUEUE, ATTACHMENT_PROCESS_CRON, {});
  await options.boss.schedule(ATTACHMENT_ORPHAN_QUEUE, ATTACHMENT_ORPHAN_CRON, {});
  await options.boss.schedule(ATTACHMENT_RECONCILE_QUEUE, ATTACHMENT_RECONCILE_CRON, {});

  // Finalise wakes the worker immediately; the cron above is the durable recovery path.
  let running: Promise<void> | null = null;
  const listener = await (options.listenSql ?? options.sql).listen(
    ATTACHMENT_PROCESS_CHANNEL,
    () => {
      if (running !== null) {
        return;
      }

      running = runAttachmentProcessing(options.sql, options.storage, {
        ...(options.scan === undefined ? {} : { scan: options.scan }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      })
        .then((result) => {
          options.logger?.info("attachment.process_wake", { ...result });
        })
        .catch((error: unknown) => {
          options.logger?.error("attachment.process_wake_failed", { error });
        })
        .finally(() => {
          running = null;
        });
    },
  );

  return {
    async stop() {
      await listener.unlisten();
      await options.boss.offWork(ATTACHMENT_PROCESS_QUEUE);
      await options.boss.offWork(ATTACHMENT_ORPHAN_QUEUE);
      await options.boss.offWork(ATTACHMENT_RECONCILE_QUEUE);
    },
  };
}
