import type { Logger } from "@bulletin/config";
import { loadEvent, type StoredEvent } from "@bulletin/domain/events";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";

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
  readonly logger?: Logger;
}

export interface EventWorker {
  stop(): Promise<void>;
}

/** Consumes relay jobs and dispatches them to the configured subscriber handlers. */
export async function createEventWorker(options: EventWorkerOptions): Promise<EventWorker> {
  const queueName = options.queueName ?? "domain-events";

  // Notify is off for the queue, so polling is the only fetch path. Polling every second
  // (rather than the default two) keeps notification delivery close to the write that caused
  // it when a run has just produced a burst of events.
  await options.boss.work<EventJob>(queueName, { pollingIntervalSeconds: 1 }, async (jobs) => {
    for (const job of jobs) {
      const handler = options.handlers[job.data.subscriber];
      const jobLogger = options.logger?.child({
        jobId: job.id,
        subscriber: job.data.subscriber,
      });

      if (handler === undefined) {
        jobLogger?.error("event.job.failed", { reason: "no handler" });
        throw new Error(`No event handler registered for ${job.data.subscriber}`);
      }

      const event = await loadEvent(options.sql, BigInt(job.data.eventId));

      if (event !== null) {
        try {
          jobLogger?.info("event.job.started");
          await handler(event);
          jobLogger?.info("event.job.completed");
        } catch (error) {
          jobLogger?.error("event.job.failed", { error });
          throw error;
        }
      }
    }
  });

  return {
    stop: () => options.boss.offWork(queueName),
  };
}
