import type { StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";

/**
 * Restore support shared by every service (ADR 0020, ADR 0012).
 *
 * The erasure journal lives in object storage, outside the database rollback set. Each erasure
 * records its key in `core.erasure_journal_applied` *before* writing the entry and then points
 * `journal/HEAD` at it, so in normal operation HEAD always names an applied key. After a
 * database restore to an earlier point, HEAD names a key the restored database has not applied:
 * services stay unready until the workers' startup replay has applied it.
 */

export const JOURNAL_PREFIX = "journal/";
export const JOURNAL_HEAD_KEY = "journal/HEAD";
/** Written by workers; a database whose outbox sequence is behind it was restored. */
export const RESTORE_WATERMARK_KEY = "ops/watermark.json";

export interface JournalHead {
  readonly key: string;
}

export function parseJournalHead(bytes: Uint8Array | string): JournalHead | null {
  try {
    const value = JSON.parse(
      typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes),
    ) as unknown;

    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { key?: unknown }).key === "string"
    ) {
      return { key: (value as { key: string }).key };
    }
  } catch {
    // An unreadable HEAD is treated as absent; the workers' replay still lists every entry.
  }

  return null;
}

export async function readJournalHead(storage: StorageClient): Promise<JournalHead | null> {
  if (!(await storage.exists(JOURNAL_HEAD_KEY))) {
    return null;
  }

  return parseJournalHead(await storage.get(JOURNAL_HEAD_KEY));
}

/** True when the database has applied the newest journalled erasure. */
export async function journalApplied(sql: SQL, storage: StorageClient): Promise<boolean> {
  const head = await readJournalHead(storage);

  if (head === null) {
    return true;
  }

  const rows = (await sql`
    SELECT 1 FROM core.erasure_journal_applied WHERE key = ${head.key}
  `) as unknown[];

  return rows.length > 0;
}

export interface JournalReadinessCheck {
  readonly name: "journal";
  check(): Promise<boolean>;
}

/**
 * Readiness check for every service that serves requests. Once the journal has been applied
 * the result is cached: later erasures cannot make an already-running process unsafe.
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
