import type { StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";

/**
 * Restore support shared by every service (ADR 0020, ADR 0012).
 *
 * The journal lives in object storage, outside the database rollback set: completed erasures,
 * and batches of revoked sessions and API keys and removed push devices. Every entry's
 * key is recorded in `core.erasure_journal_applied` *before* the entry is written, so in normal
 * operation every entry in storage is applied. After a database restore to an earlier point,
 * entries written since are not: services stay unready until the workers' startup replay has
 * applied every one of them. Readiness never relies on a single "newest" pointer, because
 * entries complete in any order.
 */

export const JOURNAL_PREFIX = "journal/";
/**
 * Erasure entries are `journal/<accepted date>/<request id, 12 digits>.json`; revocation batches
 * are `journal/<date>/rev-<epoch ms, 13 digits>-<first pending id, 12 digits>.json`.
 */
export const JOURNAL_ENTRY_KEY =
  /^journal\/\d{4}-\d{2}-\d{2}\/(?:\d{12}|rev-\d{13}-\d{12})\.json$/;
/** Written by workers; a database whose outbox sequence is behind it was restored. */
export const RESTORE_WATERMARK_KEY = "ops/watermark.json";

/** Every journal entry key in storage, oldest first. */
export async function listJournalKeys(storage: StorageClient): Promise<string[]> {
  return (await storage.list(JOURNAL_PREFIX))
    .map((object) => object.key)
    .filter((key) => JOURNAL_ENTRY_KEY.test(key))
    .sort();
}

/** True when the database has applied every journal entry in storage. */
export async function journalApplied(sql: SQL, storage: StorageClient): Promise<boolean> {
  const keys = await listJournalKeys(storage);

  if (keys.length === 0) {
    return true;
  }

  const [row] = (await sql`
    SELECT count(*)::int AS applied
    FROM core.erasure_journal_applied
    WHERE key = ANY(${`{${keys.join(",")}}`}::text[])
  `) as Array<{ applied: number }>;

  return (row?.applied ?? 0) === keys.length;
}

export interface JournalReadinessCheck {
  readonly name: "journal";
  check(): Promise<boolean>;
}

/**
 * Readiness check for every service that serves requests. Once every entry has been applied
 * the result is cached: later entries are applied before they are written, so they cannot make
 * an already-running process unsafe.
 */
export function createJournalReadinessCheck(
  sql: SQL,
  storage: StorageClient,
): JournalReadinessCheck {
  let ready = false;

  return {
    name: "journal",
    async check() {
      if (!ready) {
        ready = await journalApplied(sql, storage);
      }

      return ready;
    },
  };
}

/** True when the post-restore scan found the attachment's stored object missing. */
export async function attachmentObjectMissing(sql: SQL, attachmentId: string): Promise<boolean> {
  if (!/^\d+$/.test(attachmentId)) {
    return false;
  }

  const rows = (await sql`
    SELECT 1 FROM core.missing_objects
    WHERE kind = 'attachment' AND resource_id = ${attachmentId}
    LIMIT 1
  `) as unknown[];

  return rows.length > 0;
}
