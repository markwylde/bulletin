import {
  clientIp,
  parseCookieHeader,
  type SessionRecord,
  serializeCookie,
} from "@bulletin/domain/auth";
import { readTopicForumIds } from "@bulletin/domain/topics";
import {
  BEACON_IP_RATE_LIMIT,
  BEACON_RATE_LIMIT,
  BEACON_RATE_WINDOW_MS,
  consumeRateBucket,
  GUEST_COOKIE_MAX_AGE_SECONDS,
  guestCookieName,
  guestViewerKey,
  isGuestId,
  parseVisitContext,
  recordVisit,
} from "@bulletin/domain/visits";
import type { SQL } from "bun";

const NO_STORE = { "cache-control": "no-store" } as const;

export interface BeaconOptions {
  readonly session: SessionRecord | null;
  readonly nodeEnv: "development" | "test" | "production";
  /** HMAC key for the per-IP limit; only a rotating digest reaches `core` (ADR 0012). */
  readonly rateLimitSecret: string;
  readonly now?: Date;
}

async function readContext(request: Request): Promise<string | null> {
  const text = await request.text();

  if (text.trim() === "") {
    return null;
  }

  try {
    const value: unknown = JSON.parse(text);

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }

    const ctx = (value as Record<string, unknown>).ctx;
    return typeof ctx === "string" && ctx.length <= 64 ? ctx : null;
  } catch {
    return null;
  }
}

/**
 * `POST /api/beacon` (ADR 0006, 0018): a guest's view and presence, with a pseudonymous
 * cookie and a per-IP bucket. Members do not send it; their overlay request records visits.
 */
export async function beaconResponse(
  sql: SQL,
  request: Request,
  options: BeaconOptions,
): Promise<Response> {
  if (options.session !== null) {
    // A signed-in visitor records visits through the overlay; ignore a stray beacon.
    return new Response(null, { status: 204, headers: NO_STORE });
  }

  // The guest cookie is the rate-limit identity: a new browser gets its own budget, while a
  // shared NAT no longer puts every visitor in one bucket. The IP stays a coarse ceiling.
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const cookieName = guestCookieName(options.nodeEnv);
  const existing = cookies[cookieName];
  const guestId = isGuestId(existing) ? existing : crypto.randomUUID();
  const now = options.now;

  const guestAllowed = await consumeRateBucket(sql, {
    scope: "beacon",
    identity: guestViewerKey(guestId),
    secret: options.rateLimitSecret,
    limit: BEACON_RATE_LIMIT,
    windowMs: BEACON_RATE_WINDOW_MS,
    ...(now === undefined ? {} : { now }),
  });

  // Never the raw IP: `core.rate_buckets` is readable by the app roles (ADR 0012).
  const ipAllowed =
    guestAllowed &&
    (await consumeRateBucket(sql, {
      scope: "beacon_ip",
      identity: clientIp(request) ?? "unknown",
      secret: options.rateLimitSecret,
      limit: BEACON_IP_RATE_LIMIT,
      windowMs: BEACON_RATE_WINDOW_MS,
      ...(now === undefined ? {} : { now }),
    }));

  if (!ipAllowed) {
    return new Response(null, {
      status: 429,
      headers: { ...NO_STORE, "retry-after": String(BEACON_RATE_WINDOW_MS / 1_000) },
    });
  }

  const ctx = await readContext(request);
  const context = ctx === null ? null : parseVisitContext(ctx);

  if (ctx === null || context === null) {
    return Response.json({ code: "invalid_context" }, { status: 400, headers: NO_STORE });
  }

  let locationForumId = context.kind === "forum" ? context.id : undefined;

  if (context.kind === "topic") {
    locationForumId = (await readTopicForumIds(sql, [context.id])).get(context.id);
  }

  const headers = new Headers(NO_STORE);

  if (guestId !== existing) {
    headers.set(
      "set-cookie",
      serializeCookie(cookieName, guestId, {
        maxAge: GUEST_COOKIE_MAX_AGE_SECONDS,
        secure: options.nodeEnv === "production",
      }),
    );
  }

  await recordVisit(sql, {
    viewerKey: guestViewerKey(guestId),
    ctx,
    ...(locationForumId === undefined ? {} : { locationForumId }),
  });

  return new Response(null, { status: 204, headers });
}
