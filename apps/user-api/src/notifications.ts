import {
  isDigestFrequency,
  isNotificationChannel,
  isNotificationTypeValue,
  markAllNotificationsRead,
  markNotificationRead,
  setDigestFrequency,
  setNotificationPreference,
} from "@bulletin/domain/notifications";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;
const ID = /^[1-9]\d{0,18}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `POST /api/notifications/read`: one notification or every unread notification. */
export async function notificationReadResponse(
  sql: SQL,
  memberId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body)) {
    return json({ code: "invalid_request" }, 400);
  }

  if (body.all === true) {
    const updated = await markAllNotificationsRead(sql, memberId);
    await sql`SELECT pg_notify('notify_member', ${memberId})`;
    return json({ ok: true, updated });
  }

  if (typeof body.id !== "string" || !ID.test(body.id)) {
    return json({ code: "invalid_request" }, 400);
  }

  const updated = await markNotificationRead(sql, memberId, body.id);

  if (!updated) {
    return json({ code: "not_found" }, 404);
  }

  // Other tabs (and this page's stream) refresh the bell count from durable state.
  await sql`SELECT pg_notify('notify_member', ${memberId})`;
  return json({ ok: true, updated: 1 });
}

/** `POST /api/notifications/preferences`: one type/channel cell for the session member. */
export interface NotificationPreferenceOptions {
  /** The `web_push` flag: a disabled channel is indistinguishable from an unknown one. */
  readonly pushEnabled?: boolean;
}

export async function notificationPreferencesResponse(
  sql: SQL,
  memberId: string,
  request: Request,
  options: NotificationPreferenceOptions = {},
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (
    !isRecord(body) ||
    typeof body.type !== "string" ||
    !isNotificationTypeValue(body.type) ||
    typeof body.channel !== "string" ||
    !isNotificationChannel(body.channel) ||
    typeof body.enabled !== "boolean"
  ) {
    return json({ code: "invalid_request" }, 400);
  }

  if (body.channel === "push" && options.pushEnabled !== true) {
    return json({ code: "not_found" }, 404);
  }

  await setNotificationPreference(sql, memberId, body.type, body.channel, body.enabled);

  return json({
    ok: true,
    preference: { type: body.type, channel: body.channel, enabled: body.enabled },
  });
}

/** `POST /api/notifications/digest`: daily, weekly or off for the session member. */
export async function notificationDigestResponse(
  sql: SQL,
  memberId: string,
  request: Request,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (!isRecord(body) || typeof body.frequency !== "string" || !isDigestFrequency(body.frequency)) {
    return json({ code: "invalid_request" }, 400);
  }

  await setDigestFrequency(sql, memberId, body.frequency);
  return json({ ok: true, frequency: body.frequency });
}
