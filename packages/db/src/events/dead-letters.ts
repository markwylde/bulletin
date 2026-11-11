import type { SQL } from "bun";

/** One job that exhausted its retries, still stored by pg-boss for inspection and retry. */
export interface DeadLetter {
  readonly id: string;
  readonly queue: string;
  /** The job payload: IDs and queue metadata only, never content (ADR 0011). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly error: string | null;
  readonly failedAt: string | null;
  /** Attempts made, including the first run. */
  readonly attempts: number;
}

export interface DeadLetterPage {
  readonly entries: readonly DeadLetter[];
  readonly total: number;
}

export interface DeadLetterFilter {
  readonly limit?: number;
  readonly offset?: number;
}

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** pg-boss job ids are UUIDs; the staff route rejects anything else before querying. */
export function isJobId(value: string): boolean {
  return JOB_ID.test(value);
}

interface DeadLetterRow {
  readonly id: string;
  readonly name: string;
  readonly data: unknown;
  readonly output: unknown;
  readonly completed_on: Date | string | null;
  readonly started_on: Date | string | null;
  readonly created_on: Date | string | null;
  readonly retry_count: number;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function errorMessage(output: unknown): string | null {
  const record = parseObject(output);
  const message = record.message ?? record.error;

  if (typeof message === "string" && message.trim() !== "") {
    return message;
  }

  return Object.keys(record).length === 0 ? null : JSON.stringify(record);
}

function isoDate(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** pg-boss installs its tables on first start, so a fresh database has no job table yet. */
async function jobTableExists(sql: SQL): Promise<boolean> {
  const [row] = (await sql`SELECT to_regclass('pgboss.job') AS present`) as Array<{
    present: string | null;
  }>;
  return row?.present !== null && row?.present !== undefined;
}

/**
 * Lists jobs that exhausted their retries (pg-boss `failed`), newest failure first. The staff
 * app shows them with the stored error and can retry one (ADR 0011).
 */
export async function listDeadLetters(
  sql: SQL,
  filter: DeadLetterFilter = {},
): Promise<DeadLetterPage> {
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;

  if (!(await jobTableExists(sql))) {
    return { entries: [], total: 0 };
  }

  const [countRow] = (await sql`
    SELECT count(*)::int AS total FROM pgboss.job WHERE state = 'failed'
  `) as Array<{ total: number }>;

  const rows = (await sql`
    SELECT id, name, data, output, completed_on, started_on, created_on, retry_count
    FROM pgboss.job
    WHERE state = 'failed'
    ORDER BY completed_on DESC NULLS LAST, created_on DESC, id DESC
    LIMIT ${limit} OFFSET ${offset}
  `) as DeadLetterRow[];

  return {
    entries: rows.map((row) => ({
      id: row.id,
      queue: row.name,
      payload: parseObject(row.data),
      error: errorMessage(row.output),
      failedAt: isoDate(row.completed_on ?? row.started_on ?? row.created_on),
      attempts: row.retry_count + 1,
    })),
    total: countRow?.total ?? 0,
  };
}

/**
 * Puts a dead-lettered job back in its queue with one more retry. Returns its queue name, or
 * null when the id is not a currently failed job. pg-boss workers pick it up by polling.
 */
export async function retryDeadLetter(sql: SQL, id: string): Promise<string | null> {
  if (!isJobId(id) || !(await jobTableExists(sql))) {
    return null;
  }

  const rows = (await sql`
    UPDATE pgboss.job
    SET state = 'retry',
        retry_limit = retry_limit + 1,
        completed_on = NULL,
        start_after = GREATEST(start_after, now())
    WHERE id = ${id} AND state = 'failed'
    RETURNING name
  `) as Array<{ name: string }>;

  return rows[0]?.name ?? null;
}
