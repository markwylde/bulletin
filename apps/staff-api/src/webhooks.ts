import { listServiceMembers } from "@bulletin/domain/topics";
import {
  createWebhookDelivery,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  nextWebhookAttempt,
  readWebhookDelivery,
  saveWebhook,
  setWebhookEnabled,
  validateWebhookTarget,
  WEBHOOK_CONTENT_FIELDS,
  WEBHOOK_EVENTS,
  type WebhookTargetOptions,
} from "@bulletin/domain/webhooks";
import type { SQL } from "bun";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function withoutSecret(webhook: object): Record<string, unknown> {
  const { secret: _secret, ...safe } = webhook as Record<string, unknown>;
  return safe;
}

export async function webhooksResponse(sql: SQL): Promise<Response> {
  const [webhooks, deliveries, serviceMembers] = await Promise.all([
    listWebhooks(sql),
    listWebhookDeliveries(sql, { limit: 50 }),
    listServiceMembers(sql),
  ]);

  return json({
    webhooks: webhooks.map((webhook) => ({
      ...withoutSecret(webhook),
      lastDeliveryAt: webhook.lastDeliveryAt,
      lastDeliveryStatus: webhook.lastDeliveryStatus,
    })),
    deliveries,
    serviceMembers,
    events: WEBHOOK_EVENTS,
    contentFields: WEBHOOK_CONTENT_FIELDS,
  });
}

export interface WebhookMutationOptions {
  readonly target?: WebhookTargetOptions;
}

/**
 * Staff webhook mutations. The target is checked before saving so a production admin cannot
 * persist a private URL that delivery would only reject later (ADR 0016).
 */
export async function mutateWebhookForStaff(
  sql: SQL,
  actorId: string,
  request: Request,
  options: WebhookMutationOptions = {},
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body) || typeof body.action !== "string") {
    return json({ code: "invalid_request" }, 400);
  }

  if (body.action === "save") {
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const principalMemberId =
      typeof body.principalMemberId === "string" ? body.principalMemberId : "";
    const targetOptions: WebhookTargetOptions = options.target ?? {
      nodeEnv: Bun.env.NODE_ENV === "production" ? "production" : "development",
    };
    const target = await validateWebhookTarget(url, targetOptions);

    if (!target.ok) {
      return json({ code: "invalid_target", reason: target.code }, 400);
    }

    const result = await saveWebhook(
      sql,
      {
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        url: target.url,
        events: strings(body.events),
        principalMemberId,
        contentFields: strings(body.contentFields),
        enabled: body.enabled !== false,
        actorId,
      },
      { rotateSecret: body.rotateSecret === true },
    );

    if (!result.ok) {
      return json({ code: result.code }, result.code === "not_found" ? 404 : 400);
    }

    return json({
      ok: true,
      webhook: withoutSecret(result.webhook),
      ...(result.secret === null ? {} : { secret: result.secret }),
    });
  }

  if (body.action === "delete") {
    const id = typeof body.id === "string" ? body.id : "";
    return json({ ok: await deleteWebhook(sql, id) });
  }

  if (body.action === "toggle") {
    const id = typeof body.id === "string" ? body.id : "";
    return json({ ok: await setWebhookEnabled(sql, id, body.enabled === true) });
  }

  if (body.action === "redeliver") {
    const deliveryId = typeof body.deliveryId === "string" ? body.deliveryId : "";
    const delivery = await readWebhookDelivery(sql, deliveryId);

    if (delivery === null) {
      return json({ code: "not_found" }, 404);
    }

    const attempt = await nextWebhookAttempt(sql, delivery.webhookId, delivery.eventId);
    const next = await createWebhookDelivery(sql, {
      webhookId: delivery.webhookId,
      eventId: delivery.eventId,
      attempt,
    });

    return next === null ? json({ code: "duplicate" }, 409) : json({ ok: true, deliveryId: next });
  }

  return json({ code: "invalid_request" }, 400);
}
