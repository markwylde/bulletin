import { type RenderStatus, stableKey } from "@bulletin/cache";
import { parseCookieHeader, sessionCookieName } from "@bulletin/domain/auth";

/** CDN freshness windows (ADR 0006): 15 s fresh, 15 s stale-while-revalidate. */
export const CDN_S_MAXAGE_SECONDS = 15;
export const CDN_STALE_SECONDS = 15;

export interface CacheHeaderInput {
  /** The route contract's CDN eligibility. */
  readonly cdnCacheable: boolean;
  /** Any session cookie means the response is private (ADR 0006). */
  readonly hasSession: boolean;
  /** A password-forum unlock grant also makes the response private. */
  readonly hasUnlockGrant: boolean;
  readonly tags: readonly string[];
  readonly etag: string | null;
  /** Development builds expose the in-process cache status (ADR 0006 dev headers). */
  readonly dev: boolean;
  readonly status?: RenderStatus | null;
  readonly key?: string | null;
}

/**
 * Applies the HTTP cache contract: only guests without unlock grants on CDN-cacheable routes
 * may be cached publicly, and only by the guest preference cookie (which the proxy keys on).
 */
export function applyCacheHeaders(headers: Headers, input: CacheHeaderInput): void {
  const publiclyCacheable = input.cdnCacheable && !input.hasSession && !input.hasUnlockGrant;

  if (publiclyCacheable) {
    headers.set(
      "cache-control",
      `public, s-maxage=${CDN_S_MAXAGE_SECONDS}, stale-while-revalidate=${CDN_STALE_SECONDS}`,
    );

    if (input.tags.length > 0) {
      headers.set("surrogate-key", input.tags.join(" "));
    }
  } else {
    headers.set("cache-control", "private, no-store");
  }

  if (input.etag !== null) {
    headers.set("etag", input.etag);
  }

  if (input.dev && input.status !== null && input.status !== undefined) {
    headers.set("x-cache", input.status.toUpperCase());
  }

  if (input.dev && input.key !== null && input.key !== undefined) {
    headers.set("x-cache-key", input.key);
  }
}

/** Per-response shell bytes that are not part of the shared fragment variant (ADR 0006). */
export interface ShellVariant {
  /** `data-visitor` and the overlay/beacon choice: member and guest shells differ. */
  readonly visitor: "guest" | "member";
  /** Pages that render `data-locale-source` from the viewer's locale origin. */
  readonly localeSource?: "guest" | "member";
  /** Pages that render `data-auth-state="authenticated"`. */
  readonly authState?: "authenticated";
}

/** Canonical form of the shell dimensions, empty when the page has no varying shell. */
export function shellKey(shell: ShellVariant | undefined): string {
  if (shell === undefined) {
    return "";
  }

  return stableKey({
    visitor: shell.visitor,
    ...(shell.localeSource === undefined ? {} : { localeSource: shell.localeSource }),
    ...(shell.authState === undefined ? {} : { authState: shell.authState }),
  });
}

/**
 * The ETag covers the shared variant, the durable versions of its tags *and* the per-response
 * shell, so a permission or content change never produces a 304, and a guest's cached response
 * cannot satisfy a member's revalidation (ADR 0006).
 */
export function etagFor(
  variant: string,
  versions: ReadonlyMap<string, string>,
  shell = "",
): string {
  const canonical = [...versions]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tag, version]) => `${tag}=${version}`)
    .join(";");

  return `"${new Bun.CryptoHasher("sha256").update(`${variant}|${canonical}|${shell}`).digest("hex")}"`;
}

/**
 * True when the request carries a session cookie at all, valid or not. A revoked or expired
 * cookie must still stay private (ADR 0006: guests only, and no session cookie).
 */
export function requestHasSession(
  cookieHeader: string | null,
  nodeEnv: "development" | "test" | "production",
): boolean {
  return parseCookieHeader(cookieHeader)[sessionCookieName("user", nodeEnv)] !== undefined;
}

/** True when the request's `If-None-Match` covers the response ETag. */
export function isNotModified(ifNoneMatch: string | null, etag: string | null): boolean {
  if (ifNoneMatch === null || etag === null) {
    return false;
  }

  const normalise = (value: string): string => value.trim().replace(/^W\//, "");

  return ifNoneMatch
    .split(",")
    .map((candidate) => normalise(candidate))
    .some((candidate) => candidate === "*" || candidate === normalise(etag));
}
