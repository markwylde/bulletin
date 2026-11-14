import type { Logger } from "@bulletin/config";
import { ensurePgBossQueue } from "@bulletin/db/events";
import { type SafeFetch, safeFetch } from "@bulletin/domain/net";
import { notificationDeliveryContext } from "@bulletin/domain/notifications";
import {
  deleteDeadPushSubscription,
  markPushSubscriptionUsed,
  type PushTarget,
  pushDeliveryTarget,
  pushPayload,
  type VapidConfig,
} from "@bulletin/domain/push";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import * as webpush from "web-push";
import type { WorkerFlags } from "./flags.ts";

export const PUSH_QUEUE = "push";

export interface PushJob {
  readonly intentId: string;
}

export interface PushOptions {
  readonly vapid: VapidConfig;
  readonly logger?: Logger;
  readonly flags?: WorkerFlags;
  /** Test seam: defaults to the SSRF-safe fetch (pinned DNS, no redirects). */
  readonly fetch?: SafeFetch;
}

export interface PushDeliveryResult {
  readonly sent: number;
  readonly removed: number;
  readonly failed: number;
}

function isPermanentEndpointError(code: string): boolean {
  return (
    code === "invalid_url" ||
    code === "https_required" ||
    code === "blocked_address" ||
    code === "dns_error"
  );
}

function encryptionKeys(target: PushTarget): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  return {
    endpoint: target.endpoint,
    keys: { p256dh: target.p256dh, auth: target.auth },
  };
}

/**
 * Delivers one push intent to every device, using the content-free payload (ADR 0014).
 *
 * Permission is checked at send time through `notificationDeliveryContext`, and endpoints are
 * reached only through `safeFetch`: a subscription stored by an attacker (loopback, private,
 * metadata or rebinding host) is never contacted and is removed as permanently invalid.
 * A 404/410 from the push service deletes the dead subscription.
 */
export async function deliverNotificationPush(
  sql: SQL,
  options: PushOptions,
  intentId: string,
): Promise<PushDeliveryResult> {
  const result = { sent: 0, removed: 0, failed: 0 };
  const fetcher = options.fetch ?? safeFetch;

  return sql.begin(async (tx) => {
    const context = await notificationDeliveryContext(tx, intentId, "push");

    if (context === null) {
      return result;
    }

    if (
      options.flags !== undefined &&
      (!(await options.flags.enabled("notifications", context.memberId)) ||
        (context.type === "conversation.message" &&
          !(await options.flags.enabled("conversations", context.memberId))))
    ) {
      return result;
    }

    const targets = await pushDeliveryTarget(tx, intentId);

    if (targets === null) {
      return result;
    }

    const payload = JSON.stringify(pushPayload(context.notificationId, context.type));

    for (const target of targets) {
      let details: ReturnType<typeof webpush.generateRequestDetails>;

      try {
        details = webpush.generateRequestDetails(encryptionKeys(target), payload, {
          vapidDetails: options.vapid,
          TTL: 86_400,
          contentEncoding: "aes128gcm",
        });
      } catch {
        // A malformed stored key is unusable; never retry it forever.
        await deleteDeadPushSubscription(tx, intentId, target.id);
        result.removed += 1;
        continue;
      }

      let response: Response;

      try {
        response = await fetcher(details.endpoint, {
          method: details.method,
          headers: details.headers,
          body: details.body,
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { readonly code?: unknown }).code)
            : "network";

        if (isPermanentEndpointError(code)) {
          await deleteDeadPushSubscription(tx, intentId, target.id);
          result.removed += 1;
          continue;
        }

        // A transient failure must retry the job; earlier devices may see a duplicate.
        throw error;
      }

      if (response.status === 404 || response.status === 410) {
        await deleteDeadPushSubscription(tx, intentId, target.id);
        result.removed += 1;
        continue;
      }

      if (!response.ok) {
        throw new Error(`Push service returned ${response.status}`);
      }

      await markPushSubscriptionUsed(tx, intentId, target.id);
      result.sent += 1;
    }

    await tx`
      UPDATE core.delivery_intents
      SET delivered_at = now()
      WHERE id = ${intentId} AND delivered_at IS NULL
    `;

    return result;
  });
}

export interface PushJobsOptions extends PushOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
}

export interface PushJobs {
  stop(): Promise<void>;
}

/** Registers the push queue and its consumer. */
export async function createPushJobs(options: PushJobsOptions): Promise<PushJobs> {
  await ensurePgBossQueue(options.boss, PUSH_QUEUE);

  await options.boss.work<PushJob>(PUSH_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const result = await deliverNotificationPush(options.sql, options, job.data.intentId);
      options.logger?.info("push.delivery", { intentId: job.data.intentId, ...result });
    }
  });

  return {
    stop: () => options.boss.offWork(PUSH_QUEUE),
  };
}
