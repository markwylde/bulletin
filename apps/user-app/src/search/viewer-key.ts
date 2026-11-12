import { clientIp, parseCookieHeader } from "@bulletin/domain/auth";
import { guestCookieName, guestViewerKey, isGuestId } from "@bulletin/domain/visits";

/**
 * The flood bucket identity for one request. Members are keyed by their member ID inside
 * `consumeSearchFlood`; guests use the pseudonymous guest cookie, or a rotating digest of the
 * IP when the beacon has not set one yet (ADR 0012: no raw IPs in `core.rate_buckets`).
 */
export function searchViewerKey(
  request: Request,
  member: boolean,
  nodeEnv: "development" | "test" | "production",
  secret: string,
): string | undefined {
  if (member) {
    return undefined;
  }

  const cookie = parseCookieHeader(request.headers.get("cookie"))[guestCookieName(nodeEnv)];

  if (isGuestId(cookie)) {
    return guestViewerKey(cookie);
  }

  const ip = clientIp(request) ?? "unknown";

  return new Bun.CryptoHasher("sha256", secret).update(`search:${ip}`).digest("hex");
}
