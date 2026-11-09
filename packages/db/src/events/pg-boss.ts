import { PgBoss } from "pg-boss";
import type { JobQueue } from "./relay.ts";

export interface PgBossQueueOptions {
  readonly connectionString: string;
  readonly schema?: string;
  readonly queueName?: string;
  readonly supervise?: boolean;
  readonly schedule?: boolean;
}

export interface PgBossQueue {
  readonly queue: JobQueue;
  readonly boss: PgBoss;
  stop(): Promise<void>;
}

/** Creates the pg-boss schema/queue with the workers role's connection (ADR 0011). */
export async function createPgBossQueue(options: PgBossQueueOptions): Promise<PgBossQueue> {
  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema: options.schema ?? "pgboss",
    // The schema is created by migration 0002 and owned by the workers role.
    createSchema: false,
    supervise: options.supervise ?? true,
    schedule: options.schedule ?? true,
  });

  await boss.start();

  const queueName = options.queueName ?? "domain-events";
  const existing = await boss.getQueue(queueName);

  if (existing === null) {
    // A short queue admits one queued job per singleton key, making relay retries idempotent.
    await boss.createQueue(queueName, { policy: "short" });
  }

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
