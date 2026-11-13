import type { Logger } from "@bulletin/config";
import type { StoredEvent } from "@bulletin/domain/events";
import type { SafeFetch } from "@bulletin/domain/net";
import {
  attemptWebhookDelivery,
  createWebhookDelivery,
  markWebhookDeliveryEnqueued,
  pendingWebhookDeliveries,
  webhooksForEvent,
} from "@bulletin/domain/webhooks";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";

export const WEBHOOK_QUEUE = "webhooks";
export const WEBHOOK_RETENTION_QUEUE = "webhooks.retention";
export const WEBHOOK_RETENTION_CRON = "23 4 * * *";
/** Delivery logs are derived records retained for 30 days (ADR 0012). */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

/** Deletes delivery attempts older than the documented retention boundary. */
export async function purgeWebhookDeliveries(sql: SQL, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  const rows = (await sql`
    DELETE FROM core.webhook_deliveries
    WHERE created_at < ${cutoff}
    RETURNING 1
  `) as unknown[];

  return rows.length;
}

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
  /** Worker-side flag evaluation; the webhook flag gates fanout and delivery. */
  readonly isEnabled?: (key: string, memberId: string | null) => Promise<boolean>;
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
      if (
        options.isEnabled !== undefined &&
        !(await options.isEnabled("webhooks", webhook.principalMemberId))
      ) {
        continue;
      }

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

/** Registers the delivery worker; the relay tick sweeps pending/redelivered attempts. */
export async function createWebhookJobs(options: WebhookJobsOptions): Promise<WebhookJobs> {
  const now = options.now ?? (() => new Date());
  await ensurePgBossQueue(options.boss, WEBHOOK_QUEUE);
  await ensurePgBossQueue(options.boss, WEBHOOK_RETENTION_QUEUE);

  await options.boss.work<WebhookJobPayload>(WEBHOOK_QUEUE, async (jobs) => {
    for (const job of jobs) {
      try {
        const result = await attemptWebhookDelivery(options.sql, job.data.deliveryId, {
          now: now(),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.isEnabled === undefined ? {} : { isEnabled: options.isEnabled }),
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

  await options.boss.work(WEBHOOK_RETENTION_QUEUE, async () => {
    const purged = await purgeWebhookDeliveries(options.sql, now());
    options.logger?.info("webhook.retention.completed", { purged });
  });
  await options.boss.schedule(WEBHOOK_RETENTION_QUEUE, WEBHOOK_RETENTION_CRON, {});

  return {
    enqueuePending: enqueue,
    async stop() {
      await options.boss.offWork(WEBHOOK_QUEUE);
      await options.boss.offWork(WEBHOOK_RETENTION_QUEUE);
    },
  };
}
