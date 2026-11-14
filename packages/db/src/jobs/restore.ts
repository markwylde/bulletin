import type { Logger } from "@bulletin/config";
import {
  JOURNAL_ENTRY_KEY,
  JOURNAL_PREFIX,
  listJournalKeys,
  RESTORE_WATERMARK_KEY,
} from "@bulletin/domain/operations";
import { AVATAR_VARIANTS, avatarKey, type StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import { runAttachmentReconciliation } from "./attachments.ts";
import { type ErasureJobOptions, runErasureJob } from "./erasure.ts";

/**
 * Post-restore work (ADR 0020, ADR 0012; operations-observability tasks 4.2 and 4.4).
 *
 * 1. Replay every erasure journal entry the restored database has not applied, before any
 *    service reports ready. Erasures, the credentials they revoked and the push devices they
 *    removed come back from the journal, which is outside the database rollback set.
 * 2. Reconcile object storage against the database: objects the database no longer references
 *    are removed (the database is authoritative).
 * 3. List rows whose object is missing, for the staff app and the download error.
 *
 * A restore is detected at workers startup by comparing the outbox sequence with a watermark
 * the workers keep in object storage: sequences never go backwards except through a restore.
 */

const REPLAY_LOCK = "bulletin.erasure_journal_replay";

export interface JournalEntry {
  readonly requestId: string;
  readonly memberId: string;
  readonly postAction: "anonymise" | "delete";
  readonly sessionIds: readonly string[];
  readonly apiKeyIds: readonly string[];
  readonly pushDeviceIds: readonly string[];
}

/** A batch of standalone revocations: IDs only, never personal data (ADR 0011, 0012). */
export interface RevocationJournalEntry {
  readonly kind: "revocations";
  readonly sessionIds: readonly string[];
  readonly apiKeyIds: readonly string[];
  readonly pushDeviceIds: readonly string[];
}

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && /^\d+$/.test(entry))
    : [];
}

function parseRecord(bytes: Uint8Array | string): Record<string, unknown> | null {
  let value: unknown;

  try {
    value = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));
  } catch {
    return null;
  }

  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function parseJournalEntry(bytes: Uint8Array | string): JournalEntry | null {
  const record = parseRecord(bytes);

  if (
    record === null ||
    typeof record.requestId !== "string" ||
    !/^\d+$/.test(record.requestId) ||
    typeof record.memberId !== "string" ||
    !/^\d+$/.test(record.memberId)
  ) {
    return null;
  }

  return {
    requestId: record.requestId,
    memberId: record.memberId,
    // Entries written before the journal carried the post action keep the default.
    postAction: record.postAction === "delete" ? "delete" : "anonymise",
    sessionIds: ids(record.sessionIds),
    apiKeyIds: ids(record.apiKeyIds),
    pushDeviceIds: ids(record.pushDeviceIds),
  };
}

export function parseRevocationEntry(bytes: Uint8Array | string): RevocationJournalEntry | null {
  const record = parseRecord(bytes);

  if (record === null || record.kind !== "revocations") {
    return null;
  }

  return {
    kind: "revocations",
    sessionIds: ids(record.sessionIds),
    apiKeyIds: ids(record.apiKeyIds),
    pushDeviceIds: ids(record.pushDeviceIds),
  };
}

function isRevocationKey(key: string): boolean {
  return /\/rev-\d{13}-\d{12}\.json$/.test(key);
}

function pgBigintArray(values: readonly string[]): string {
  return `{${values.join(",")}}`;
}

export interface JournalReplayOptions {
  readonly sql: SQL;
  readonly storage: StorageClient;
  readonly logger?: Logger;
  readonly erasure?: ErasureJobOptions;
}

export interface JournalReplayResult {
  /** Erasure entries whose erasure ran again on this database. */
  readonly replayed: number;
  /** Erasure entries already reflected here (completed, or the member postdates the restore). */
  readonly recorded: number;
  /** Revocation batches applied again. */
  readonly revocations: number;
  readonly skipped: readonly string[];
}

/**
 * Applies every journal entry missing from `core.erasure_journal_applied`. Replicas serialise
 * on an advisory lock; a replica that waited finds the entries already applied.
 */
export async function replayErasureJournal(
  options: JournalReplayOptions,
): Promise<JournalReplayResult> {
  const reserved = await options.sql.reserve();

  try {
    await reserved`SELECT pg_advisory_lock(hashtextextended(${REPLAY_LOCK}, 0))`;

    try {
      return await replayLocked(options);
    } finally {
      await reserved`SELECT pg_advisory_unlock(hashtextextended(${REPLAY_LOCK}, 0))`;
    }
  } finally {
    reserved.release();
  }
}

async function replayLocked(options: JournalReplayOptions): Promise<JournalReplayResult> {
  const { sql, storage } = options;
  const keys = await listJournalKeys(storage);

  if (keys.length === 0) {
    return { replayed: 0, recorded: 0, revocations: 0, skipped: [] };
  }

  const appliedRows = (await sql`
    SELECT key FROM core.erasure_journal_applied
  `) as Array<{ key: string }>;
  const applied = new Set(appliedRows.map((row) => row.key));
  let replayed = 0;
  let recorded = 0;
  let revocations = 0;
  const skipped: string[] = [];

  for (const key of keys) {
    if (applied.has(key)) {
      continue;
    }

    const bytes = await storage.get(key);

    if (isRevocationKey(key)) {
      const batch = parseRevocationEntry(bytes);

      if (batch === null) {
        options.logger?.warn("restore.journal_entry_unreadable", { key });
        skipped.push(key);
        continue;
      }

      await sql`
        SELECT pii.replay_revocations(
          ${pgBigintArray(batch.sessionIds)}::bigint[],
          ${pgBigintArray(batch.apiKeyIds)}::bigint[],
          ${pgBigintArray(batch.pushDeviceIds)}::bigint[]
        )
      `;
      await sql`
        INSERT INTO core.erasure_journal_applied (key, request_id, replayed)
        VALUES (${key}, NULL, true)
        ON CONFLICT (key) DO UPDATE SET replayed = true
      `;
      revocations += 1;
      continue;
    }

    const entry = parseJournalEntry(bytes);

    if (entry === null) {
      options.logger?.warn("restore.journal_entry_unreadable", { key });
      skipped.push(key);
      continue;
    }

    const [row] = (await sql`
      SELECT pii.replay_erasure(
        ${entry.requestId},
        ${entry.memberId},
        ${entry.postAction},
        ${pgBigintArray(entry.sessionIds)}::bigint[],
        ${pgBigintArray(entry.apiKeyIds)}::bigint[],
        ${pgBigintArray(entry.pushDeviceIds)}::bigint[]
      ) AS result
    `) as Array<{ result: { status?: string; requestId?: string } | string }>;
    const result =
      typeof row?.result === "string"
        ? (JSON.parse(row.result) as { status?: string; requestId?: string })
        : (row?.result ?? {});

    if (result.status === "replay" && result.requestId !== undefined) {
      await runErasureJob(sql, storage, result.requestId, {
        ...options.erasure,
        journalReplayKey: key,
      });
      replayed += 1;
    } else {
      recorded += 1;
    }

    await sql`
      INSERT INTO core.erasure_journal_applied (key, request_id, replayed)
      VALUES (${key}, ${entry.requestId}, ${result.status === "replay"})
      ON CONFLICT (key) DO UPDATE SET replayed = EXCLUDED.replayed OR core.erasure_journal_applied.replayed
    `;
  }

  if (replayed > 0 || recorded > 0 || revocations > 0) {
    options.logger?.info("restore.journal_replayed", { replayed, recorded, revocations });
  }

  return { replayed, recorded, revocations, skipped };
}

export interface MissingObjectScanResult {
  readonly missing: number;
  readonly resolved: number;
}

/**
 * Rebuilds `core.missing_objects`: ready attachments and current avatars whose object is not
 * in storage. Rows whose object exists again (restored from a previous version) are removed.
 */
export async function scanMissingObjects(
  sql: SQL,
  storage: StorageClient,
): Promise<MissingObjectScanResult> {
  const [attachmentObjects, avatarObjects] = await Promise.all([
    storage.list("att/"),
    storage.list("av/"),
  ]);
  const present = new Set([...attachmentObjects, ...avatarObjects].map((object) => object.key));
  const attachments = (await sql`
    SELECT id::text AS id, storage_key
    FROM core.attachments
    WHERE state = 'ready' AND storage_key IS NOT NULL
  `) as Array<{ id: string; storage_key: string }>;
  const avatars = (await sql`
    SELECT id::text AS id, avatar_hash
    FROM core.members
    WHERE avatar_hash IS NOT NULL
  `) as Array<{ id: string; avatar_hash: string }>;
  const missing: Array<{ kind: "attachment" | "avatar"; id: string; key: string }> = [];

  for (const attachment of attachments) {
    if (!present.has(attachment.storage_key)) {
      missing.push({ kind: "attachment", id: attachment.id, key: attachment.storage_key });
    }
  }

  for (const avatar of avatars) {
    for (const variant of AVATAR_VARIANTS) {
      const key = avatarKey(avatar.id, avatar.avatar_hash, variant);

      if (!present.has(key)) {
        missing.push({ kind: "avatar", id: avatar.id, key });
      }
    }
  }

  return sql.begin(async (tx) => {
    const keys = missing.map((entry) => entry.key);
    const resolved = (await tx`
      DELETE FROM core.missing_objects
      WHERE NOT (storage_key = ANY(${`{${keys.map((key) => `"${key}"`).join(",")}}`}::text[]))
      RETURNING id
    `) as unknown[];

    for (const entry of missing) {
      await tx`
        INSERT INTO core.missing_objects (kind, resource_id, storage_key)
        VALUES (${entry.kind}, ${entry.id}, ${entry.key})
        ON CONFLICT (kind, storage_key) DO NOTHING
      `;
    }

    return { missing: missing.length, resolved: resolved.length };
  });
}

interface Watermark {
  readonly eventsSequence: string;
  readonly writtenAt: string;
}

async function outboxSequence(sql: SQL): Promise<bigint> {
  const [row] = (await sql`
    SELECT last_value::text AS value, is_called FROM core.events_id_seq
  `) as Array<{ value: string; is_called: boolean }>;

  return row === undefined ? 0n : row.is_called ? BigInt(row.value) : BigInt(row.value) - 1n;
}

async function readWatermark(storage: StorageClient): Promise<Watermark | null> {
  if (!(await storage.exists(RESTORE_WATERMARK_KEY))) {
    return null;
  }

  try {
    const value = JSON.parse(
      new TextDecoder().decode(await storage.get(RESTORE_WATERMARK_KEY)),
    ) as Partial<Watermark>;

    return typeof value.eventsSequence === "string" && /^\d+$/.test(value.eventsSequence)
      ? { eventsSequence: value.eventsSequence, writtenAt: String(value.writtenAt ?? "") }
      : null;
  } catch {
    return null;
  }
}

/**
 * Records how far the outbox sequence has advanced. It never moves the watermark backwards,
 * except with `force` once a post-restore run has completed: the restored database is then the
 * new timeline.
 */
export async function writeRestoreWatermark(
  sql: SQL,
  storage: StorageClient,
  options: { readonly force?: boolean } = {},
): Promise<void> {
  const current = await outboxSequence(sql);
  const previous = await readWatermark(storage);

  if (options.force !== true && previous !== null && BigInt(previous.eventsSequence) > current) {
    return;
  }

  await storage.put(
    RESTORE_WATERMARK_KEY,
    `${JSON.stringify({ eventsSequence: current.toString(), writtenAt: new Date().toISOString() })}\n`,
    { contentType: "application/json" },
  );
}

/** True when the database is behind the watermark, i.e. it was restored to an earlier point. */
export async function detectRestore(sql: SQL, storage: StorageClient): Promise<boolean> {
  const watermark = await readWatermark(storage);

  return watermark !== null && (await outboxSequence(sql)) < BigInt(watermark.eventsSequence);
}

export interface PostRestoreOptions extends JournalReplayOptions {
  readonly trigger: "detected" | "manual";
  /** Reconciliation grace for objects uploaded moments ago (defaults to the job's 15 min). */
  readonly reconcileGraceMs?: number;
}

export interface PostRestoreResult {
  readonly runId: string;
  readonly replay: JournalReplayResult;
  readonly removedObjects: number;
  readonly missing: MissingObjectScanResult;
}

/** Journal replay, then reconciliation, then the missing-object scan; recorded in restore_runs. */
export async function runPostRestore(options: PostRestoreOptions): Promise<PostRestoreResult> {
  const { sql, storage } = options;
  const [run] = (await sql`
    INSERT INTO core.restore_runs (trigger) VALUES (${options.trigger})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const runId = run?.id ?? "0";

  try {
    const replay = await replayErasureJournal(options);
    const reconciled = await runAttachmentReconciliation(sql, storage, {
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.reconcileGraceMs === undefined ? {} : { graceMs: options.reconcileGraceMs }),
    });
    const missing = await scanMissingObjects(sql, storage);

    await sql`
      UPDATE core.restore_runs
      SET finished_at = now(), status = 'completed', replayed = ${replay.replayed},
          removed_objects = ${reconciled.deleted}, missing_objects = ${missing.missing}
      WHERE id = ${runId}
    `;
    await writeRestoreWatermark(sql, storage, { force: true });
    options.logger?.info("restore.completed", {
      trigger: options.trigger,
      replayed: replay.replayed,
      removedObjects: reconciled.deleted,
      missingObjects: missing.missing,
    });

    return { runId, replay, removedObjects: reconciled.deleted, missing };
  } catch (error) {
    await sql`
      UPDATE core.restore_runs SET finished_at = now(), status = 'failed' WHERE id = ${runId}
    `.catch(() => undefined);
    throw error;
  }
}

/**
 * Workers startup, before the service reports ready: run the full post-restore sequence when a
 * restore is detected. Otherwise still replay any journal entry this database lacks, and still
 * reconcile storage and rescan for missing files: the watermark is written once a minute, so a
 * backup taken after the latest write restores to a sequence equal to or ahead of it and is not
 * detected. Reconciling on every start makes that case converge too; it is idempotent and keeps
 * the job's grace for fresh uploads.
 */
export async function prepareAfterRestore(
  options: JournalReplayOptions & { readonly reconcileGraceMs?: number },
): Promise<{ readonly restored: boolean; readonly replayed: number }> {
  if (await detectRestore(options.sql, options.storage)) {
    const result = await runPostRestore({ ...options, trigger: "detected" });
    return { restored: true, replayed: result.replay.replayed };
  }

  const replay = await replayErasureJournal(options);
  const reconciled = await runAttachmentReconciliation(options.sql, options.storage, {
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.reconcileGraceMs === undefined ? {} : { graceMs: options.reconcileGraceMs }),
  });
  const missing = await scanMissingObjects(options.sql, options.storage);
  await writeRestoreWatermark(options.sql, options.storage);

  if (reconciled.deleted > 0 || missing.missing > 0) {
    options.logger?.warn("restore.startup_reconciled", {
      removedObjects: reconciled.deleted,
      missingObjects: missing.missing,
    });
  }

  return { restored: false, replayed: replay.replayed };
}

const REVOCATION_BATCH = 1_000;

/**
 * Moves pending revocations (written by triggers on sessions, API keys and push devices) into one
 * journal entry. The applied row and the entry are written inside the transaction that deletes
 * the pending rows: a failed upload leaves them pending, and an entry whose commit failed is
 * re-applied by the next replay. Returns the number of revocations journalled.
 */
export async function drainRevocationJournal(
  sql: SQL,
  storage: StorageClient,
  options: { readonly now?: Date; readonly limit?: number } = {},
): Promise<number> {
  return sql.begin(async (tx) => {
    const rows = (await tx`
      SELECT id::text AS id, kind, target_id::text AS target_id
      FROM core.revocation_journal_pending
      ORDER BY id
      LIMIT ${options.limit ?? REVOCATION_BATCH}
      FOR UPDATE SKIP LOCKED
    `) as Array<{ id: string; kind: string; target_id: string }>;

    if (rows.length === 0) {
      return 0;
    }

    const now = options.now ?? new Date();
    const unique = (kind: string) => [
      ...new Set(rows.filter((row) => row.kind === kind).map((row) => row.target_id)),
    ];
    const key = `journal/${now.toISOString().slice(0, 10)}/rev-${String(now.getTime()).padStart(
      13,
      "0",
    )}-${(rows[0]?.id ?? "0").padStart(12, "0")}.json`;

    await tx`
      INSERT INTO core.erasure_journal_applied (key, request_id)
      VALUES (${key}, NULL)
      ON CONFLICT (key) DO NOTHING
    `;
    await storage.put(
      key,
      `${JSON.stringify({
        kind: "revocations",
        sessionIds: unique("session"),
        apiKeyIds: unique("api_key"),
        pushDeviceIds: unique("push_device"),
        writtenAt: now.toISOString(),
      })}\n`,
      { contentType: "application/json" },
    );
    await tx`
      DELETE FROM core.revocation_journal_pending
      WHERE id = ANY(${pgBigintArray(rows.map((row) => row.id))}::bigint[])
    `;

    return rows.length;
  });
}

/** Recovery window plus a day: no restore can need an entry older than this. */
export const JOURNAL_RETENTION_DAYS = 36;

/** Removes journal entries (and their applied rows) older than the recovery window. */
export async function pruneJournal(
  sql: SQL,
  storage: StorageClient,
  options: { readonly now?: Date; readonly retentionDays?: number } = {},
): Promise<number> {
  const cutoff =
    (options.now ?? new Date()).getTime() -
    (options.retentionDays ?? JOURNAL_RETENTION_DAYS) * 86_400_000;
  const expired = (await storage.list(JOURNAL_PREFIX))
    .filter((object) => JOURNAL_ENTRY_KEY.test(object.key))
    .filter((object) => object.lastModified.getTime() < cutoff)
    .map((object) => object.key);

  for (const key of expired) {
    await storage.delete(key);
  }

  if (expired.length > 0) {
    await sql`
      DELETE FROM core.erasure_journal_applied
      WHERE key = ANY(${`{${expired.join(",")}}`}::text[])
    `;
  }

  return expired.length;
}
