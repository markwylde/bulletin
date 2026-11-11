import type { Logger } from "@bulletin/config";
import {
  type AttachmentScan,
  deleteAttachments,
  isAttachmentContentType,
  listAttachmentKeys,
  listExpiredAttachments,
  listProcessableAttachments,
  publishAttachment,
  readAttachmentById,
  rejectAttachment,
  sha256Hex,
} from "@bulletin/domain/attachments";
import {
  AttachmentProcessingError,
  processAttachmentBytes,
} from "@bulletin/domain/attachments/processing";
import {
  type AttachmentRecord,
  attachmentKey,
  isManagedKey,
  type StorageClient,
  thumbnailKeyFor,
  transitionAttachment,
} from "@bulletin/storage";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";
import { listUnfurlImageKeys } from "./unfurl-images.ts";

/** Every ten seconds: publish snapshotted uploads so the editor sees them promptly. */
export const ATTACHMENT_PROCESS_QUEUE = "attachment.process";
export const ATTACHMENT_PROCESS_CRON = "*/10 * * * * *";
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

  const ready = await publishAttachment(sql, record, {
    storageKey: finalKey,
    sizeBytes: publishedBytes.byteLength,
    sha256: sha256Hex(publishedBytes),
    verifiedType: processed.contentType,
  });

  if (ready === null) {
    return { kind: "skipped" };
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

  return { kind: "ready", attachment: ready };
}

export interface AttachmentProcessingResult {
  readonly processed: number;
  readonly rejected: number;
  readonly failed: number;
}

/** One sweep of the snapshotted/stale-processing queue. */
export async function runAttachmentProcessing(
  sql: SQL,
  storage: StorageClient,
  options: ProcessAttachmentOptions & { readonly limit?: number } = {},
): Promise<AttachmentProcessingResult> {
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

  return { processed, rejected, failed };
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
  const expired = await listExpiredAttachments(
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

  const deleted = await deleteAttachments(
    sql,
    expired.map((record) => record.id),
  );

  if (deleted > 0) {
    options.logger?.info("attachment.orphans_deleted", { deleted });
  }

  return { deleted };
}

/** Removes `att/`, `quarantine/` and `processing/` objects with no authoritative row. */
export async function runAttachmentReconciliation(
  sql: SQL,
  storage: StorageClient,
  options: { readonly logger?: Logger } = {},
): Promise<AttachmentSweepResult> {
  const [objects, rows, unfurlKeys] = await Promise.all([
    storage.list(""),
    listAttachmentKeys(sql),
    listUnfurlImageKeys(sql),
  ]);
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

  let deleted = 0;

  for (const object of objects) {
    const isAttachmentKey =
      object.key.startsWith("att/") ||
      object.key.startsWith("quarantine/") ||
      object.key.startsWith("processing/") ||
      object.key.startsWith("unfurl/");

    if (!isAttachmentKey || !isManagedKey(object.key) || live.has(object.key)) {
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

  return {
    async stop() {
      await options.boss.offWork(ATTACHMENT_PROCESS_QUEUE);
      await options.boss.offWork(ATTACHMENT_ORPHAN_QUEUE);
      await options.boss.offWork(ATTACHMENT_RECONCILE_QUEUE);
    },
  };
}
