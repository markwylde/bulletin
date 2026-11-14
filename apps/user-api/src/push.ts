import { type AuthNodeEnv, parseCookieHeader, sessionCookieName } from "@bulletin/domain/auth";
import { safeFetchDevAllowlist } from "@bulletin/domain/net";
import { notificationPreview } from "@bulletin/domain/notifications";
import {
  deletePushDevice,
  listPushDevices,
  loadVapidConfig,
  savePushSubscription,
  validatePushEndpoint,
} from "@bulletin/domain/push";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The raw user-session token for the `pii` device functions; the session was already checked. */
export function userSessionToken(request: Request, nodeEnv: AuthNodeEnv): string | null {
  return (
    parseCookieHeader(request.headers.get("cookie"))[sessionCookieName("user", nodeEnv)] ?? null
  );
}

/** `GET /api/push/config`: the VAPID public key the browser needs to subscribe. */
export function pushConfigResponse(nodeEnv: AuthNodeEnv): Response {
  return json({ publicKey: loadVapidConfig(Bun.env, nodeEnv).publicKey });
}

/** `GET /api/push/devices`: the member's own labels and dates, never endpoints or keys. */
export async function pushDevicesResponse(
  sql: SQL,
  request: Request,
  nodeEnv: AuthNodeEnv,
): Promise<Response> {
  const token = userSessionToken(request, nodeEnv);

  if (token === null) {
    return json({ code: "unauthenticated" }, 401);
  }

  const devices = await listPushDevices(sql, token);
  return json({ devices });
}

export interface PushSubscriptionRequestOptions {
  readonly nodeEnv: AuthNodeEnv;
  readonly devAllow?: readonly string[];
}

/** `POST /api/push/subscribe`: validated endpoint plus the browser's encryption keys. */
export async function pushSubscribeResponse(
  sql: SQL,
  request: Request,
  options: PushSubscriptionRequestOptions,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);

  if (
    !isRecord(body) ||
    typeof body.endpoint !== "string" ||
    !isRecord(body.keys) ||
    typeof body.keys.p256dh !== "string" ||
    typeof body.keys.auth !== "string"
  ) {
    return json({ code: "invalid_request" }, 400);
  }

  const validation = await validatePushEndpoint(body.endpoint, {
    nodeEnv: options.nodeEnv,
    devAllow: options.devAllow ?? safeFetchDevAllowlist(),
  });

  if (!validation.ok) {
    return json({ code: "invalid_endpoint" }, 400);
  }

  const token = userSessionToken(request, options.nodeEnv);

  if (token === null) {
    return json({ code: "unauthenticated" }, 401);
  }

  const deviceId = await savePushSubscription(sql, token, {
    endpoint: validation.url?.toString() ?? body.endpoint,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
    label: typeof body.label === "string" ? body.label.slice(0, 80) : null,
    userAgent: request.headers.get("user-agent"),
  });

  return deviceId === null ? json({ code: "invalid_request" }, 400) : json({ deviceId });
}

/** `POST /api/push/devices/delete`: removal is scoped to the session member's own device. */
export async function pushDeleteDeviceResponse(
  sql: SQL,
  request: Request,
  nodeEnv: AuthNodeEnv,
): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const token = userSessionToken(request, nodeEnv);

  if (token === null) {
    return json({ code: "unauthenticated" }, 401);
  }

  if (!isRecord(body) || typeof body.deviceId !== "string") {
    return json({ code: "invalid_request" }, 400);
  }

  return (await deletePushDevice(sql, token, body.deviceId))
    ? json({ ok: true })
    : json({ code: "not_found" }, 404);
}

/** `GET /api/notifications/<id>/preview`: the authenticated details behind a push. */
export async function notificationPreviewResponse(
  sql: SQL,
  memberId: string,
  id: string,
): Promise<Response> {
  const preview = await notificationPreview(sql, memberId, id);

  if (preview === null) {
    return json({ code: "not_found" }, 404);
  }

  return json({
    n: preview.notificationId,
    t: preview.titleKey,
    body: preview.body,
    url: preview.url,
  });
}
