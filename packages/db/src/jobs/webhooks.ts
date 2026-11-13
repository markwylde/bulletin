import type { Logger } from "@bulletin/config";
import type { StoredEvent } from "@bulletin/domain/events";
import type { SafeFetch } from "@bulletin/domain/net";
import {
  attemptWebhookDelivery,
  createWebhookDelivery,
  markWebhookDeliveryEnqueued,
  nextWebhookAttempt,
  pendingWebhookDeliveries,
  webhooksForEvent,
} from "@bulletin/domain/webhooks";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

export const WEBHOOK_QUEUE = "webhooks";

export interface WebhookJobPayload {
  /** Jobs carry IDs only; the worker loads the webhook, event and secret (ADR 0011). */
  readonly deliveryId: string;
}

export interface WebhookJobs {
  stop(): Promise<void>;
  /** Picks up redeliveries and crashed initial enqueues; called from the relay tick. */
  enqueuePending(): Promise<void>;
}

export interface WebhookJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly logger?: Logger;
  readonly fetch?: SafeFetch;
  readonly now?: () => Date;
}

async function sendDelivery(boss: PgBoss, deliveryId: string, startAfter?: Date): Promise<void> {
  await boss.send(WEBHOOK_QUEUE, { deliveryId } satisfies WebhookJobPayload, {
    singletonKey: `webhook:${deliveryId}`,
    ...(startAfter === undefined ? {} : { startAfter }),
  });
}

async function enqueuePending(sql: SQL, boss: PgBoss, limit = 100): Promise<void> {
  for (const delivery of await pendingWebhookDeliveries(sql, limit)) {
    await sendDelivery(boss, delivery.id);
    await markWebhookDeliveryEnqueued(sql, delivery.id);
  }
}

/**
 * The webhook relay subscriber. It turns one domain event into one pending attempt per
 * subscribed webhook; the queue worker performs and logs each attempt.
 */
export function createWebhookEventHandler(
  options: WebhookJobsOptions,
): (event: StoredEvent) => Promise<void> {
  return async (event) => {
    const webhooks = await webhooksForEvent(options.sql, event.type);

    for (const webhook of webhooks) {
      const deliveryId = await createWebhookDelivery(options.sql, {
        webhookId: webhook.id,
        eventId: event.id.toString(),
        attempt: 1,
      });

      if (deliveryId === null) {
        continue;
      }

      try {
        await sendDelivery(options.boss, deliveryId);
        await markWebhookDeliveryEnqueued(options.sql, deliveryId);
      } catch (error) {
        options.logger?.error("webhook.enqueue.failed", {
          webhookId: webhook.id,
          eventId: event.id.toString(),
          error,
        });
      }
    }
  };
}

/** Registers the delivery worker and a minute sweep for pending/redelivered attempts. */
export async function createWebhookJobs(options: WebhookJobsOptions): Promise<WebhookJobs> {
  const now = options.now ?? (() => new Date());
  await ensurePgBossQueue(options.boss, WEBHOOK_QUEUE);

  await options.boss.work<WebhookJobPayload>(WEBHOOK_QUEUE, async (jobs) => {
    for (const job of jobs) {
      try {
        const result = await attemptWebhookDelivery(options.sql, job.data.deliveryId, {
          now: now(),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });

        if (result === null) {
          continue;
        }

        options.logger?.info("webhook.delivery", {
          deliveryId: job.data.deliveryId,
          status: result.status,
          httpStatus: result.httpStatus,
          responseMs: result.responseMs,
        });

        if (result.status === "failed" && result.retryAt !== null) {
          const delivery = (await options.sql`
            SELECT webhook_id::text AS webhook_id, event_id::text AS event_id
            FROM core.webhook_deliveries WHERE id = ${job.data.deliveryId}
          `) as Array<{ webhook_id: string; event_id: string }>;
          const row = delivery[0];

          if (row === undefined) {
            continue;
          }

          const attempt = await nextWebhookAttempt(options.sql, row.webhook_id, row.event_id);
          const nextId = await createWebhookDelivery(options.sql, {
            webhookId: row.webhook_id,
            eventId: row.event_id,
            attempt,
          });

          if (nextId !== null) {
            await sendDelivery(options.boss, nextId, result.retryAt);
            await markWebhookDeliveryEnqueued(options.sql, nextId);
          }
        }
      } catch (error) {
        options.logger?.error("webhook.delivery.failed", {
          deliveryId: job.data.deliveryId,
          error,
        });
        throw error;
      }
    }
  });

  const enqueue = async (): Promise<void> => {
    await enqueuePending(options.sql, options.boss);
  };

  return {
    enqueuePending: enqueue,
    async stop() {
      await options.boss.offWork(WEBHOOK_QUEUE);
    },
  };
}
