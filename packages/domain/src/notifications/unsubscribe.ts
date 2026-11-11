import { createHmac, timingSafeEqual } from "node:crypto";
import { isNotificationTypeValue } from "./preferences.ts";
import type { NotificationType } from "./repository.ts";

export type UnsubscribeScope = NotificationType | "digest";

export interface UnsubscribeClaims {
  readonly memberId: string;
  readonly type: UnsubscribeScope;
  /** Unix milliseconds. */
  readonly expiresAt: number;
}

function signature(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

/** HMAC-signed, expiring unsubscribe token for one member and notification type. */
export function createUnsubscribeToken(secret: string, claims: UnsubscribeClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const mac = signature(secret, payload).toString("base64url");
  return `${payload}.${mac}`;
}

export function verifyUnsubscribeToken(
  secret: string,
  token: string,
  now: number = Date.now(),
): UnsubscribeClaims | null {
  const [payload, mac] = token.split(".");

  if (payload === undefined || mac === undefined || payload === "" || mac === "") {
    return null;
  }

  const expected = signature(secret, payload);
  const provided = Buffer.from(mac, "base64url");

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  let claims: unknown;

  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof claims !== "object" || claims === null) {
    return null;
  }

  const record = claims as Record<string, unknown>;

  if (
    typeof record.memberId !== "string" ||
    !/^[1-9]\d{0,18}$/.test(record.memberId) ||
    typeof record.type !== "string" ||
    (record.type !== "digest" && !isNotificationTypeValue(record.type)) ||
    typeof record.expiresAt !== "number" ||
    !Number.isFinite(record.expiresAt) ||
    record.expiresAt <= now
  ) {
    return null;
  }

  return {
    memberId: record.memberId,
    type: record.type,
    expiresAt: record.expiresAt,
  };
}
