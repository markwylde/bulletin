import { type MetricsRegistry, metrics, standardMetrics } from "@bulletin/config/metrics";
import type { SQL } from "bun";

/** The staff panel highlights a queue whose oldest runnable job is older than this (spec). */
export const QUEUE_LAG_WARNING_SECONDS = 30;

export interface QueueStat {
  readonly queue: string;
  /** Jobs waiting to run (created or retrying). */
  readonly depth: number;
  /** Seconds since the oldest runnable job became runnable; 0 when the queue is empty. */
  readonly lagSeconds: number;
  readonly active: number;
  readonly deadLetters: number;
}

export interface OutboxStat {
  readonly unpublished: number;
  /** Seconds since the oldest unpublished event was written; 0 when caught up. */
  readonly lagSeconds: number;
}

async function jobTableExists(sql: SQL): Promise<boolean> {
  const [row] = (await sql`SELECT to_regclass('pgboss.job') AS present`) as Array<{
    present: string | null;
  }>;
  return row?.present !== null && row?.present !== undefined;
}

/** Depth, lag and dead letters per pg-boss queue (ADR 0011, 0020). */
export async function readQueueStats(sql: SQL): Promise<QueueStat[]> {
  if (!(await jobTableExists(sql))) {
    return [];
  }

  const rows = (await sql`
    SELECT
      name,
      count(*) FILTER (
        WHERE state IN ('created', 'retry')
      )::int AS depth,
      COALESCE(EXTRACT(EPOCH FROM now() - min(start_after) FILTER (
        WHERE state IN ('created', 'retry') AND start_after <= now()
      )), 0)::float8 AS lag_seconds,
      count(*) FILTER (WHERE state = 'active')::int AS active,
      count(*) FILTER (WHERE state = 'failed')::int AS dead_letters
    FROM pgboss.job
    WHERE state IN ('created', 'retry', 'active', 'failed')
    GROUP BY name
    ORDER BY name
  `) as Array<{
    name: string;
    depth: number;
    lag_seconds: number;
    active: number;
    dead_letters: number;
  }>;

  return rows.map((row) => ({
    queue: row.name,
    depth: row.depth,
    lagSeconds: Math.max(0, Number(row.lag_seconds)),
    active: row.active,
    deadLetters: row.dead_letters,
  }));
}

/** Unpublished outbox events and the age of the oldest one (ADR 0011 relay lag). */
export async function readOutboxStats(sql: SQL): Promise<OutboxStat> {
  const [row] = (await sql`
    SELECT
      count(*)::int AS unpublished,
      COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float8 AS lag_seconds
    FROM core.events
    WHERE published_at IS NULL
  `) as Array<{ unpublished: number; lag_seconds: number }>;

  return {
    unpublished: row?.unpublished ?? 0,
    lagSeconds: Math.max(0, Number(row?.lag_seconds ?? 0)),
  };
}

/** Exports queue depth/lag, dead letters and outbox lag on every scrape (workers). */
export function registerQueueCollector(sql: SQL, registry: MetricsRegistry = metrics): () => void {
  return registry.addCollector(async () => {
    const [queues, outbox] = await Promise.all([readQueueStats(sql), readOutboxStats(sql)]);

    standardMetrics.queueDepth.replace(queues.map((stat) => [{ queue: stat.queue }, stat.depth]));
    standardMetrics.queueLag.replace(
      queues.map((stat) => [{ queue: stat.queue }, stat.lagSeconds]),
    );
    standardMetrics.deadLetters.replace(
      queues.map((stat) => [{ queue: stat.queue }, stat.deadLetters]),
    );
    standardMetrics.outboxLag.set({}, outbox.lagSeconds);
  });
}
