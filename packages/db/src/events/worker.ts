import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { loadEvent, type StoredEvent } from "./events.ts";

export interface EventJob {
  readonly eventId: string;
  readonly subscriber: string;
}

export type EventHandler = (event: StoredEvent) => Promise<void>;

export interface EventWorkerOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly handlers: Readonly<Record<string, EventHandler>>;
  readonly queueName?: string;
}

export interface EventWorker {
  stop(): Promise<void>;
}

/** Consumes relay jobs and dispatches them to the configured subscriber handlers. */
export async function createEventWorker(options: EventWorkerOptions): Promise<EventWorker> {
  const queueName = options.queueName ?? "domain-events";

  await options.boss.work<EventJob>(queueName, async (jobs) => {
    for (const job of jobs) {
      const handler = options.handlers[job.data.subscriber];

      if (handler === undefined) {
        throw new Error(`No event handler registered for ${job.data.subscriber}`);
      }

      const event = await loadEvent(options.sql, BigInt(job.data.eventId));

      if (event !== null) {
        await handler(event);
      }
    }
  });

  return {
    stop: () => options.boss.offWork(queueName),
  };
}
