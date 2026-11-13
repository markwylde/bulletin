import type { SQL } from "bun";
import type { EventType } from "../events/index.ts";
import {
  canonicalWebhookContentFields,
  canonicalWebhookEvents,
  isWebhookEvent,
  type WebhookContentField,
  type WebhookEventType,
} from "./events.ts";

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed" | "skipped";

export interface WebhookRecord {
  readonly id: string;
  readonly url: string;
  /** The HMAC secret; never returned by the staff list endpoint. */
  readonly secret: string;
  readonly events: readonly WebhookEventType[];
  readonly principalMemberId: string;
  readonly principalName: string | null;
  readonly contentFields: readonly WebhookContentField[];
  readonly enabled: boolean;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly failureSince: Date | null;
  readonly disabledAt: Date | null;
  readonly disabledReason: string | null;
}

export interface WebhookSummary extends Omit<WebhookRecord, "secret"> {
  readonly lastDeliveryAt: Date | null;
  readonly lastDeliveryStatus: WebhookDeliveryStatus | null;
}

export interface WebhookDeliveryRecord {
  readonly id: string;
  readonly webhookId: string;
  readonly eventId: string;
  readonly attempt: number;
  readonly status: WebhookDeliveryStatus;
  readonly httpStatus: number | null;
  readonly responseMs: number | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface WebhookDeliveryView extends WebhookDeliveryRecord {
  readonly eventType: string;
  readonly webhookUrl: string;
}

interface WebhookRow {
  readonly id: string;
  readonly url: string;
  readonly secret: string;
  readonly events: unknown;
  readonly principal_member_id: string;
  readonly principal_name: string | null;
  readonly content_fields: unknown;
  readonly enabled: boolean;
  readonly created_by: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly failure_since: Date | null;
  readonly disabled_at: Date | null;
  readonly disabled_reason: string | null;
  readonly last_delivery_at?: Date | null;
  readonly last_delivery_status?: WebhookDeliveryStatus | null;
}

interface DeliveryRow {
  readonly id: string;
  readonly webhook_id: string;
  readonly event_id: string;
  readonly attempt: number;
  readonly status: WebhookDeliveryStatus;
  readonly http_status: number | null;
  readonly response_ms: number | null;
  readonly error: string | null;
  readonly created_at: Date;
  readonly completed_at: Date | null;
}

function toWebhook(row: WebhookRow): WebhookRecord {
  return {
    id: row.id,
    url: row.url,
    secret: row.secret,
    events: canonicalWebhookEvents(
      Array.isArray(row.events)
        ? row.events.filter((value): value is string => typeof value === "string")
        : [],
    ),
    principalMemberId: row.principal_member_id,
    principalName: row.principal_name,
    contentFields: canonicalWebhookContentFields(
      Array.isArray(row.content_fields)
        ? row.content_fields.filter((value): value is string => typeof value === "string")
        : [],
    ),
    enabled: row.enabled,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    failureSince: row.failure_since === null ? null : new Date(row.failure_since),
    disabledAt: row.disabled_at === null ? null : new Date(row.disabled_at),
    disabledReason: row.disabled_reason,
  };
}

function toDelivery(row: DeliveryRow): WebhookDeliveryRecord {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    attempt: row.attempt,
    status: row.status,
    httpStatus: row.http_status,
    responseMs: row.response_ms,
    error: row.error,
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at),
  };
}

export function webhookSecret(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export async function listWebhooks(sql: SQL): Promise<readonly WebhookSummary[]> {
  const rows = (await sql`
    SELECT
      w.id::text AS id,
      w.url,
      w.secret,
      w.events,
      w.principal_member_id::text AS principal_member_id,
      principal.display_name AS principal_name,
      w.content_fields,
      w.enabled,
      w.created_by::text AS created_by,
      w.created_at,
      w.updated_at,
      w.failure_since,
      w.disabled_at,
      w.disabled_reason,
      last_delivery.created_at AS last_delivery_at,
      last_delivery.status AS last_delivery_status
    FROM core.webhooks w
    LEFT JOIN core.members principal ON principal.id = w.principal_member_id
    LEFT JOIN LATERAL (
      SELECT created_at, status
      FROM core.webhook_deliveries
      WHERE webhook_id = w.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) last_delivery ON true
    ORDER BY w.created_at DESC, w.id DESC
  `) as WebhookRow[];

  return rows.map((row) => ({
    ...toWebhook(row),
    lastDeliveryAt:
      row.last_delivery_at === null || row.last_delivery_at === undefined
        ? null
        : new Date(row.last_delivery_at),
    lastDeliveryStatus: row.last_delivery_status ?? null,
  }));
}

export async function readWebhook(sql: SQL, webhookId: string): Promise<WebhookRecord | null> {
  if (!/^\d+$/.test(webhookId)) {
    return null;
  }

  const [row] = (await sql`
    SELECT
      w.id::text AS id,
      w.url,
      w.secret,
      w.events,
      w.principal_member_id::text AS principal_member_id,
      principal.display_name AS principal_name,
      w.content_fields,
      w.enabled,
      w.created_by::text AS created_by,
      w.created_at,
      w.updated_at,
      w.failure_since,
      w.disabled_at,
      w.disabled_reason
    FROM core.webhooks w
    LEFT JOIN core.members principal ON principal.id = w.principal_member_id
    WHERE w.id = ${webhookId}
  `) as WebhookRow[];

  return row === undefined ? null : toWebhook(row);
}

export interface SaveWebhookInput {
  readonly id?: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly principalMemberId: string;
  readonly contentFields: readonly string[];
  readonly enabled: boolean;
  readonly actorId: string;
}

export type WebhookSaveResult =
  | { readonly ok: true; readonly webhook: WebhookRecord; readonly secret: string | null }
  | {
      readonly ok: false;
      readonly code: "invalid_request" | "duplicate" | "not_found";
    };

async function serviceMemberExists(sql: SQL, memberId: string): Promise<boolean> {
  if (!/^\d+$/.test(memberId)) {
    return false;
  }

  const rows = (await sql`
    SELECT 1 FROM core.members
    WHERE id = ${memberId} AND is_service = true AND state = 'active'
    LIMIT 1
  `) as unknown[];

  return rows.length > 0;
}

/** Creates or updates a webhook. Only creation (or an explicit rotate) returns the secret. */
export async function saveWebhook(
  sql: SQL,
  input: SaveWebhookInput,
  options: { readonly rotateSecret?: boolean } = {},
): Promise<WebhookSaveResult> {
  const url = input.url.trim();
  const events = canonicalWebhookEvents(input.events);
  const contentFields = canonicalWebhookContentFields(input.contentFields);

  if (
    url === "" ||
    url.length > 2_048 ||
    events.length === 0 ||
    !(await serviceMemberExists(sql, input.principalMemberId))
  ) {
    return { ok: false, code: "invalid_request" };
  }

  if (input.id === undefined) {
    const secret = webhookSecret();
    const [row] = (await sql`
      INSERT INTO core.webhooks (
        url, secret, events, principal_member_id, content_fields, enabled, created_by
      )
      VALUES (
        ${url}, ${secret}, ${`{${events.join(",")}}`}::text[],
        ${input.principalMemberId}, ${`{${contentFields.join(",")}}`}::text[],
        ${input.enabled}, ${input.actorId}
      )
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    if (row === undefined) {
      return { ok: false, code: "invalid_request" };
    }

    const webhook = await readWebhook(sql, row.id);
    return webhook === null ? { ok: false, code: "not_found" } : { ok: true, webhook, secret };
  }

  const secret = options.rotateSecret === true ? webhookSecret() : null;
  const rows = (await sql`
    UPDATE core.webhooks
    SET url = ${url},
        events = ${`{${events.join(",")}}`}::text[],
        principal_member_id = ${input.principalMemberId},
        content_fields = ${`{${contentFields.join(",")}}`}::text[],
        enabled = ${input.enabled},
        updated_at = now(),
        ${secret === null ? sql`` : sql`secret = ${secret},`}
        failure_since = CASE WHEN ${input.enabled} THEN NULL ELSE failure_since END,
        disabled_at = CASE WHEN ${input.enabled} THEN NULL ELSE disabled_at END,
        disabled_reason = CASE WHEN ${input.enabled} THEN NULL ELSE disabled_reason END
    WHERE id = ${input.id}
    RETURNING 1
  `) as unknown[];

  if (rows.length === 0) {
    return { ok: false, code: "not_found" };
  }

  const webhook = await readWebhook(sql, input.id);
  return webhook === null ? { ok: false, code: "not_found" } : { ok: true, webhook, secret };
}

export async function deleteWebhook(sql: SQL, webhookId: string): Promise<boolean> {
  if (!/^\d+$/.test(webhookId)) {
    return false;
  }

  const rows = (await sql`
    DELETE FROM core.webhooks WHERE id = ${webhookId} RETURNING 1
  `) as unknown[];

  return rows.length > 0;
}

export async function setWebhookEnabled(
  sql: SQL,
  webhookId: string,
  enabled: boolean,
): Promise<boolean> {
  if (!/^\d+$/.test(webhookId)) {
    return false;
  }

  const rows = (await sql`
    UPDATE core.webhooks
    SET enabled = ${enabled},
        failure_since = CASE WHEN ${enabled} THEN NULL ELSE failure_since END,
        disabled_at = CASE WHEN ${enabled} THEN NULL ELSE disabled_at END,
        disabled_reason = CASE WHEN ${enabled} THEN NULL ELSE disabled_reason END,
        updated_at = now()
    WHERE id = ${webhookId}
    RETURNING 1
  `) as unknown[];

  return rows.length > 0;
}

/** Enabled webhooks subscribed to one event, used by the relay subscriber. */
export async function webhooksForEvent(
  sql: SQL,
  eventType: EventType,
): Promise<readonly WebhookRecord[]> {
  if (!isWebhookEvent(eventType)) {
    return [];
  }

  const rows = (await sql`
    SELECT
      w.id::text AS id,
      w.url,
      w.secret,
      w.events,
      w.principal_member_id::text AS principal_member_id,
      principal.display_name AS principal_name,
      w.content_fields,
      w.enabled,
      w.created_by::text AS created_by,
      w.created_at,
      w.updated_at,
      w.failure_since,
      w.disabled_at,
      w.disabled_reason
    FROM core.webhooks w
    LEFT JOIN core.members principal ON principal.id = w.principal_member_id
    WHERE w.enabled = true AND ${eventType} = ANY(w.events)
    ORDER BY w.id
  `) as WebhookRow[];

  return rows.map(toWebhook);
}

export interface CreateDeliveryInput {
  readonly webhookId: string;
  readonly eventId: string;
  readonly attempt: number;
}

/** Inserts one pending attempt; a relay replay cannot duplicate the same attempt. */
export async function createWebhookDelivery(
  sql: SQL,
  input: CreateDeliveryInput,
): Promise<string | null> {
  const rows = (await sql`
    INSERT INTO core.webhook_deliveries (webhook_id, event_id, attempt, status)
    VALUES (${input.webhookId}, ${input.eventId}, ${input.attempt}, 'pending')
    ON CONFLICT (webhook_id, event_id, attempt) DO NOTHING
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  return rows[0]?.id ?? null;
}

export async function readWebhookDelivery(
  sql: SQL,
  deliveryId: string,
): Promise<WebhookDeliveryRecord | null> {
  if (!/^\d+$/.test(deliveryId)) {
    return null;
  }

  const [row] = (await sql`
    SELECT id::text AS id, webhook_id::text AS webhook_id, event_id::text AS event_id,
      attempt, status, http_status, response_ms, error, created_at, completed_at
    FROM core.webhook_deliveries
    WHERE id = ${deliveryId}
  `) as DeliveryRow[];

  return row === undefined ? null : toDelivery(row);
}

export async function markWebhookDeliveryEnqueued(
  sql: SQL,
  deliveryId: string,
  now: Date = new Date(),
): Promise<void> {
  await sql`
    UPDATE core.webhook_deliveries
    SET enqueued_at = ${now}
    WHERE id = ${deliveryId} AND status = 'pending' AND enqueued_at IS NULL
  `;
}

/** Pending attempts not yet handed to pg-boss; the worker sweep retries crashed enqueues. */
export async function pendingWebhookDeliveries(
  sql: SQL,
  limit = 100,
): Promise<readonly { readonly id: string; readonly webhookId: string }[]> {
  const rows = (await sql`
    SELECT id::text AS id, webhook_id::text AS webhook_id
    FROM core.webhook_deliveries
    WHERE status = 'pending' AND enqueued_at IS NULL
    ORDER BY created_at, id
    LIMIT ${limit}
  `) as Array<{ id: string; webhook_id: string }>;

  return rows.map((row) => ({ id: row.id, webhookId: row.webhook_id }));
}

export interface DeliveryResult {
  readonly status: Exclude<WebhookDeliveryStatus, "pending">;
  readonly httpStatus: number | null;
  readonly responseMs: number;
  readonly error: string | null;
  readonly signatureTimestamp: Date | null;
}

export async function completeWebhookDelivery(
  sql: SQL,
  deliveryId: string,
  result: DeliveryResult,
  now: Date = new Date(),
): Promise<void> {
  await sql`
    UPDATE core.webhook_deliveries
    SET status = ${result.status},
        http_status = ${result.httpStatus},
        response_ms = ${result.responseMs},
        error = ${result.error === null ? null : result.error.slice(0, 500)},
        signature_timestamp = ${result.signatureTimestamp},
        completed_at = ${now}
    WHERE id = ${deliveryId} AND status = 'pending'
  `;
}

export async function listWebhookDeliveries(
  sql: SQL,
  input: { readonly webhookId?: string; readonly limit?: number } = {},
): Promise<readonly WebhookDeliveryView[]> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const webhookId =
    input.webhookId !== undefined && /^\d+$/.test(input.webhookId) ? input.webhookId : null;
  const rows = (await sql`
    SELECT d.id::text AS id, d.webhook_id::text AS webhook_id, d.event_id::text AS event_id,
      d.attempt, d.status, d.http_status, d.response_ms, d.error, d.created_at, d.completed_at,
      e.type AS event_type, w.url AS webhook_url
    FROM core.webhook_deliveries d
    JOIN core.events e ON e.id = d.event_id
    JOIN core.webhooks w ON w.id = d.webhook_id
    WHERE (${webhookId}::bigint IS NULL OR d.webhook_id = ${webhookId}::bigint)
    ORDER BY d.created_at DESC, d.id DESC
    LIMIT ${limit}
  `) as Array<DeliveryRow & { event_type: string; webhook_url: string }>;

  return rows.map((row) => ({
    ...toDelivery(row),
    eventType: row.event_type,
    webhookUrl: row.webhook_url,
  }));
}

export async function nextWebhookAttempt(
  sql: SQL,
  webhookId: string,
  eventId: string,
): Promise<number> {
  const [row] = (await sql`
    SELECT coalesce(max(attempt), 0)::int + 1 AS next
    FROM core.webhook_deliveries
    WHERE webhook_id = ${webhookId} AND event_id = ${eventId}
  `) as Array<{ next: number }>;

  return row?.next ?? 1;
}
