import { PgBoss } from "pg-boss";
import type { JobQueue } from "./relay.ts";

export interface PgBossQueueOptions {
  readonly connectionString: string;
  readonly schema?: string;
  readonly queueName?: string;
  readonly supervise?: boolean;
  readonly schedule?: boolean;
  readonly max?: number;
}

export interface PgBossQueue {
  readonly queue: JobQueue;
  readonly boss: PgBoss;
  stop(): Promise<void>;
}

/** Retry policy shared by every core queue (ADR 0011). */
export const PGBOSS_RETRY_OPTIONS = {
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 600,
} as const;

/** Creates a queue if needed and keeps its retry policy current; safe on every start. */
export async function ensurePgBossQueue(
  boss: PgBoss,
  name: string,
  policy: "short" | "standard" = "short",
): Promise<void> {
  const existing = await boss.getQueue(name);

  if (existing === null) {
    await boss.createQueue(name, { policy, ...PGBOSS_RETRY_OPTIONS });
  } else {
    await boss.updateQueue(name, PGBOSS_RETRY_OPTIONS);
  }
}

/** Creates the pg-boss schema/queue with the workers role's connection (ADR 0011). */
export async function createPgBossQueue(options: PgBossQueueOptions): Promise<PgBossQueue> {
  const boss = new PgBoss({
    connectionString: options.connectionString,
    connectionTimeoutMillis: 5_000,
    schema: options.schema ?? "pgboss",
    ...(options.max === undefined ? {} : { max: options.max }),
    // The schema is created by migration 0002 and owned by the workers role.
    createSchema: false,
    supervise: options.supervise ?? true,
    schedule: options.schedule ?? true,
  });

  await boss.start();

  const queueName = options.queueName ?? "domain-events";
  await ensurePgBossQueue(boss, queueName);

  const queue: JobQueue = {
    async send(name, payload, sendOptions) {
      await boss.send(name, payload, { singletonKey: sendOptions.singletonKey });
    },
  };

  return {
    queue,
    boss,
    stop: () => boss.stop(),
  };
}
