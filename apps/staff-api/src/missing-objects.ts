import type { SQL } from "bun";

/**
 * Rows whose stored object is missing after a restore (ADR 0020; operations-observability
 * task 4.2). The post-restore scan in workers fills `core.missing_objects`; staff see what to
 * recover from bucket versions, or what to tell the affected members.
 */

export const MISSING_OBJECTS_LIMIT = 200;

export interface MissingObjectItem {
  readonly id: string;
  readonly kind: "attachment" | "avatar";
  readonly resourceId: string;
  readonly storageKey: string;
  readonly detectedAt: string;
  /** The first post that shows the attachment, for staff to open. */
  readonly postId: string | null;
}

export interface RestoreRunSummary {
  readonly id: string;
  readonly trigger: "detected" | "manual";
  readonly status: "running" | "completed" | "failed";
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly replayed: number;
  readonly removedObjects: number;
  readonly missingObjects: number;
}

export interface MissingObjectsReport {
  readonly total: number;
  readonly items: readonly MissingObjectItem[];
  readonly lastRun: RestoreRunSummary | null;
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export async function readMissingObjects(sql: SQL): Promise<MissingObjectsReport> {
  const [count] = (await sql`
    SELECT count(*)::int AS total FROM core.missing_objects
  `) as Array<{ total: number }>;
  const rows = (await sql`
    SELECT
      m.id::text AS id,
      m.kind,
      m.resource_id::text AS resource_id,
      m.storage_key,
      m.detected_at,
      (
        SELECT min(pa.post_id)::text
        FROM core.post_attachments pa
        WHERE m.kind = 'attachment' AND pa.attachment_id = m.resource_id
      ) AS post_id
    FROM core.missing_objects m
    ORDER BY m.detected_at DESC, m.id DESC
    LIMIT ${MISSING_OBJECTS_LIMIT}
  `) as Array<{
    id: string;
    kind: "attachment" | "avatar";
    resource_id: string;
    storage_key: string;
    detected_at: Date | string;
    post_id: string | null;
  }>;
  const [run] = (await sql`
    SELECT id::text AS id, trigger, status, started_at, finished_at, replayed,
           removed_objects, missing_objects
    FROM core.restore_runs
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  `) as Array<{
    id: string;
    trigger: "detected" | "manual";
    status: "running" | "completed" | "failed";
    started_at: Date | string;
    finished_at: Date | string | null;
    replayed: number;
    removed_objects: number;
    missing_objects: number;
  }>;

  return {
    total: count?.total ?? 0,
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      resourceId: row.resource_id,
      storageKey: row.storage_key,
      detectedAt: iso(row.detected_at) ?? "",
      postId: row.post_id,
    })),
    lastRun:
      run === undefined
        ? null
        : {
            id: run.id,
            trigger: run.trigger,
            status: run.status,
            startedAt: iso(run.started_at) ?? "",
            finishedAt: iso(run.finished_at),
            replayed: run.replayed,
            removedObjects: run.removed_objects,
            missingObjects: run.missing_objects,
          },
  };
}
