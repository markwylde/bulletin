import { createHmac } from "node:crypto";
import { ensureCurrentRendering } from "@bulletin/content";
import type { SQL } from "bun";
import { listEmbedProviders } from "../content/embeds.ts";
import { loadEvent, type StoredEvent } from "../events/index.ts";
import { loadReplaceWords } from "../filters/repository.ts";
import { type SafeFetch, safeFetch } from "../net/index.ts";
import { can, loadForumTree, loadPermissionSnapshot } from "../permissions/index.ts";
import { readReactionTarget } from "../reactions/index.ts";
import {
  readPostContext,
  readTopic,
  readTopicPostById,
  type TopicPostRow,
  type TopicPostVisibility,
} from "../topics/index.ts";
import { canonicalUrl } from "../urls/index.ts";
import type { WebhookContentField } from "./events.ts";
import type { WebhookRecord } from "./repository.ts";
import {
  completeWebhookDelivery,
  createWebhookDelivery,
  readWebhook,
  readWebhookDelivery,
} from "./repository.ts";

/** A webhook that keeps failing for this long is disabled (webhooks spec). */
export const WEBHOOK_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const WEBHOOK_RETRY_BASE_MS = 30_000;
const WEBHOOK_RETRY_MAX_MS = 6 * 60 * 60 * 1_000;

/** Exponential backoff from 30 seconds up to six hours, within the 24-hour window. */
export function webhookRetryDelayMs(attempt: number): number {
  return Math.min(WEBHOOK_RETRY_MAX_MS, WEBHOOK_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

function idFrom(event: StoredEvent, key: string): string | null {
  const value = event.payloadIds[key];
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

interface WebhookEventPayload {
  readonly id: string;
  readonly type: string;
  readonly createdAt: Date;
  readonly data: Readonly<Record<string, unknown>>;
  readonly content?: Readonly<Record<string, unknown>>;
}

async function permissionScope(sql: SQL, webhook: WebhookRecord, forumId: string) {
  const tree = await loadForumTree(sql);
  const snapshot = await loadPermissionSnapshot(sql, webhook.principalMemberId, {
    tree,
    sessionId: null,
  });

  return {
    allowed: await can(sql, webhook.principalMemberId, "read", {
      forumId,
      tree,
      sessionId: null,
      snapshot,
    }),
    seeUnapproved: await can(sql, webhook.principalMemberId, "see_unapproved", {
      forumId,
      tree,
      sessionId: null,
      snapshot,
    }),
    seeDeleted: await can(sql, webhook.principalMemberId, "see_deleted", {
      forumId,
      tree,
      sessionId: null,
      snapshot,
    }),
  };
}

function visible(
  visibility: TopicPostVisibility,
  seeUnapproved: boolean,
  seeDeleted: boolean,
): boolean {
  return (
    visibility === "visible" ||
    (visibility === "unapproved" && seeUnapproved) ||
    (visibility === "soft_deleted" && seeDeleted)
  );
}

function contentFrom(
  fields: readonly WebhookContentField[],
  topicTitle: string,
  body: {
    readonly bodyMd: string;
    readonly bodyHtml: string;
    readonly bodyText: string;
  } | null,
): Readonly<Record<string, unknown>> | null {
  if (fields.length === 0) {
    return null;
  }

  const content: Record<string, unknown> = {};

  if (fields.includes("title")) {
    content.title = topicTitle;
  }

  if (body !== null) {
    if (fields.includes("bodyMd")) {
      content.bodyMd = body.bodyMd;
    }

    if (fields.includes("bodyHtml")) {
      content.bodyHtml = body.bodyHtml;
    }

    if (fields.includes("bodyText")) {
      content.bodyText = body.bodyText;
    }
  }

  return content;
}

/** Re-sanitises stale stored HTML before a webhook may include it (ADR 0007). */
async function currentWebhookBody(
  sql: SQL,
  post: TopicPostRow,
): Promise<{
  readonly bodyMd: string;
  readonly bodyHtml: string;
  readonly bodyText: string;
}> {
  const [replaceWords, embedProviders] = await Promise.all([
    loadReplaceWords(sql),
    listEmbedProviders(sql),
  ]);
  const current = await ensureCurrentRendering(
    {
      bodyHtml: post.bodyHtml,
      bodyText: post.bodyText,
      renderVersion: post.renderVersion,
      sanitiserVersion: post.sanitiserVersion,
    },
    { profile: "post", replaceWords, embedProviders },
  );

  return { bodyMd: post.bodyMd, bodyHtml: current.bodyHtml, bodyText: current.bodyText };
}

/**
 * Builds the delivery payload at send time. Restricted PII never enters; content fields are
 * opt-in and the principal must still be able to read the resource now (ADR 0016, 0011).
 */
export async function buildWebhookPayload(
  sql: SQL,
  webhook: WebhookRecord,
  event: StoredEvent,
): Promise<WebhookEventPayload | null> {
  const topicId = idFrom(event, "topicId");
  const postId = idFrom(event, "postId");

  if (postId !== null) {
    const context = await readPostContext(sql, postId);

    if (context === null) {
      return null;
    }

    const [topic, scope] = await Promise.all([
      readTopic(sql, context.topicId),
      permissionScope(sql, webhook, context.forumId),
    ]);

    if (topic === null || !scope.allowed) {
      return null;
    }

    if (
      !visible(topic.visibility, scope.seeUnapproved, scope.seeDeleted) ||
      !visible(context.visibility, scope.seeUnapproved, scope.seeDeleted)
    ) {
      return null;
    }

    const post = await readTopicPostById(sql, {
      topicId: topic.id,
      postId,
      seeUnapproved: scope.seeUnapproved,
      seeDeleted: scope.seeDeleted,
    });

    if (post === null) {
      return null;
    }

    const body = webhook.contentFields.some((field) => field !== "title")
      ? await currentWebhookBody(sql, post)
      : post;
    const content = contentFrom(webhook.contentFields, topic.title, body);

    return {
      id: event.id.toString(),
      type: event.type,
      createdAt: event.createdAt,
      data: {
        ...event.payloadIds,
        url: `${canonicalUrl("topic", topic.id, topic.slug, { postId })}`,
      },
      ...(content === null ? {} : { content }),
    };
  }

  if (topicId !== null) {
    const topic = await readTopic(sql, topicId);

    if (topic === null) {
      return null;
    }

    const scope = await permissionScope(sql, webhook, topic.forumId);

    if (!scope.allowed || !visible(topic.visibility, scope.seeUnapproved, scope.seeDeleted)) {
      return null;
    }

    let body: {
      readonly bodyMd: string;
      readonly bodyHtml: string;
      readonly bodyText: string;
    } | null = null;

    if (topic.firstPostId !== null && webhook.contentFields.some((field) => field !== "title")) {
      const post = await readTopicPostById(sql, {
        topicId: topic.id,
        postId: topic.firstPostId,
        seeUnapproved: scope.seeUnapproved,
        seeDeleted: scope.seeDeleted,
      });

      if (post !== null) {
        body = await currentWebhookBody(sql, post);
      }
    }

    const content = contentFrom(webhook.contentFields, topic.title, body);

    return {
      id: event.id.toString(),
      type: event.type,
      createdAt: event.createdAt,
      data: {
        ...event.payloadIds,
        url: canonicalUrl("topic", topic.id, topic.slug),
      },
      ...(content === null ? {} : { content }),
    };
  }

  if (event.type === "reaction.added") {
    const reactionPostId = idFrom(event, "postId");

    if (reactionPostId === null) {
      return null;
    }

    const target = await readReactionTarget(sql, reactionPostId);

    if (target === null) {
      return null;
    }

    const [topic, scope] = await Promise.all([
      readTopic(sql, target.topicId),
      permissionScope(sql, webhook, target.forumId),
    ]);

    if (topic === null || !scope.allowed) {
      return null;
    }

    if (
      !visible(topic.visibility, scope.seeUnapproved, scope.seeDeleted) ||
      !visible(target.visibility, scope.seeUnapproved, scope.seeDeleted)
    ) {
      return null;
    }

    return {
      id: event.id.toString(),
      type: event.type,
      createdAt: event.createdAt,
      data: {
        ...event.payloadIds,
        url: `${canonicalUrl("topic", topic.id, topic.slug, { postId: target.postId })}`,
      },
    };
  }

  return null;
}

/** Signs `timestamp.body` as required by ADR 0016. */
export function signWebhookPayload(
  secret: string,
  timestampSeconds: number,
  body: string,
): { readonly timestamp: string; readonly signature: string } {
  const timestamp = String(timestampSeconds);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

  return { timestamp, signature: `sha256=${signature}` };
}

async function notifyAdminsDisabled(
  sql: SQL,
  webhook: WebhookRecord,
  eventId: string,
  now: Date,
): Promise<void> {
  const admins = (await sql`
    SELECT DISTINCT mg.member_id::text AS member_id
    FROM core.member_groups mg
    JOIN core.groups g ON g.id = mg.group_id
    WHERE g.key = 'administrators'
  `) as Array<{ member_id: string }>;

  for (const admin of admins) {
    await sql`
      INSERT INTO core.notifications (member_id, type, event_id, created_at, updated_at)
      SELECT ${admin.member_id}, 'webhook.disabled', ${eventId}, ${now}, ${now}
      WHERE NOT EXISTS (
        SELECT 1 FROM core.notifications
        WHERE member_id = ${admin.member_id}
          AND type = 'webhook.disabled'
          AND event_id = ${eventId}
      )
    `;
  }

  await sql`
    UPDATE core.webhooks
    SET enabled = false,
        disabled_at = ${now},
        disabled_reason = 'continuous_failure',
        failure_since = coalesce(failure_since, ${now}),
        updated_at = ${now}
    WHERE id = ${webhook.id}
  `;
}

export interface AttemptWebhookResult {
  readonly status: "delivered" | "failed" | "skipped";
  readonly httpStatus: number | null;
  readonly responseMs: number;
  readonly error: string | null;
  readonly retryAt: Date | null;
  readonly disabled: boolean;
}

export interface AttemptWebhookOptions {
  readonly fetch?: SafeFetch;
  readonly now?: Date;
  /** Gates queued deliveries after the `webhooks` flag is turned off. */
  readonly isEnabled?: (key: string, memberId: string | null) => Promise<boolean>;
}

/**
 * Performs one logged attempt. Retry scheduling is the worker's job; this function only
 * decides whether another attempt fits inside the 24-hour failure window.
 */
export async function attemptWebhookDelivery(
  sql: SQL,
  deliveryId: string,
  options: AttemptWebhookOptions = {},
): Promise<AttemptWebhookResult | null> {
  const now = options.now ?? new Date();
  const delivery = await readWebhookDelivery(sql, deliveryId);

  if (delivery === null || delivery.status !== "pending") {
    return null;
  }

  const webhook = await readWebhook(sql, delivery.webhookId);
  const event = await loadEvent(sql, BigInt(delivery.eventId));
  const featureEnabled =
    webhook === null ||
    options.isEnabled === undefined ||
    (await options.isEnabled("webhooks", webhook.principalMemberId));

  if (webhook === null || event === null || !webhook.enabled || !featureEnabled) {
    const result: AttemptWebhookResult = {
      status: "skipped",
      httpStatus: null,
      responseMs: 0,
      error:
        webhook === null
          ? "webhook_missing"
          : event === null
            ? "event_missing"
            : !featureEnabled
              ? "feature_disabled"
              : "webhook_disabled",
      retryAt: null,
      disabled: webhook !== null && !webhook.enabled,
    };
    await completeWebhookDelivery(
      sql,
      deliveryId,
      {
        status: "skipped",
        httpStatus: null,
        responseMs: 0,
        error: result.error,
        signatureTimestamp: null,
      },
      now,
    );
    return result;
  }

  const payload = await buildWebhookPayload(sql, webhook, event);

  if (payload === null) {
    const result: AttemptWebhookResult = {
      status: "skipped",
      httpStatus: null,
      responseMs: 0,
      error: "not_visible_or_missing",
      retryAt: null,
      disabled: false,
    };
    await completeWebhookDelivery(
      sql,
      deliveryId,
      {
        status: "skipped",
        httpStatus: null,
        responseMs: 0,
        error: result.error,
        signatureTimestamp: null,
      },
      now,
    );
    return result;
  }

  const body = JSON.stringify(payload);
  const signed = signWebhookPayload(webhook.secret, Math.floor(now.getTime() / 1_000), body);
  const started = Date.now();
  let response: Response | null = null;
  let error: string | null = null;

  try {
    response = await (options.fetch ?? safeFetch)(webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-bulletin-timestamp": signed.timestamp,
        "x-bulletin-signature": signed.signature,
      },
      body,
    });
  } catch (caught) {
    error =
      typeof caught === "object" && caught !== null && "code" in caught
        ? String((caught as { code?: unknown }).code)
        : "network";
  }

  const responseMs = Math.max(0, Date.now() - started);
  const delivered =
    error === null && response !== null && response.status >= 200 && response.status < 300;
  const httpStatus = response?.status ?? null;

  if (delivered) {
    await completeWebhookDelivery(
      sql,
      deliveryId,
      {
        status: "delivered",
        httpStatus,
        responseMs,
        error: null,
        signatureTimestamp: new Date(Number(signed.timestamp) * 1_000),
      },
      now,
    );
    await sql`
      UPDATE core.webhooks
      SET failure_since = NULL, updated_at = ${now}
      WHERE id = ${webhook.id}
    `;

    return {
      status: "delivered",
      httpStatus,
      responseMs,
      error: null,
      retryAt: null,
      disabled: false,
    };
  }

  const failureError = error ?? `http_${httpStatus ?? 0}`;
  const outcome = await sql.begin(async (tx) => {
    const [fresh] = (await tx`
      SELECT failure_since, enabled
      FROM core.webhooks
      WHERE id = ${webhook.id}
      FOR UPDATE
    `) as Array<{ failure_since: Date | null; enabled: boolean }>;

    await completeWebhookDelivery(
      tx,
      deliveryId,
      {
        status: "failed",
        httpStatus,
        responseMs,
        error: failureError,
        signatureTimestamp: new Date(Number(signed.timestamp) * 1_000),
      },
      now,
    );

    if (fresh === undefined || !fresh.enabled) {
      return { retryAt: null, disabled: true };
    }

    const failureSince = fresh.failure_since === null ? now : new Date(fresh.failure_since);
    const failureWindowEnd = failureSince.getTime() + WEBHOOK_FAILURE_WINDOW_MS;
    await tx`
      UPDATE core.webhooks
      SET failure_since = coalesce(failure_since, ${now}), updated_at = ${now}
      WHERE id = ${webhook.id}
    `;

    if (now.getTime() >= failureWindowEnd) {
      await notifyAdminsDisabled(tx, webhook, delivery.eventId, now);
      return { retryAt: null, disabled: true };
    }

    const desired = now.getTime() + webhookRetryDelayMs(delivery.attempt);
    const retryAtMs = Math.min(desired, delivery.retryDeadline.getTime());
    const retryAt = retryAtMs > now.getTime() ? new Date(retryAtMs) : null;

    if (retryAt === null) {
      // This event's own 24-hour window is exhausted; other events and the webhook itself may
      // still be healthy, so this is not an auto-disable.
      return { retryAt: null, disabled: false };
    }

    // The failure and its retry intent commit together. A worker crash before enqueueing the
    // successor leaves this pending row for the sweep to find at its deadline.
    await createWebhookDelivery(tx, {
      webhookId: webhook.id,
      eventId: delivery.eventId,
      attempt: delivery.attempt + 1,
      scheduledAt: retryAt,
      retryDeadline: delivery.retryDeadline,
    });

    return { retryAt, disabled: false };
  });

  return {
    status: "failed",
    httpStatus,
    responseMs,
    error: failureError,
    retryAt: outcome.retryAt,
    disabled: outcome.disabled,
  };
}
