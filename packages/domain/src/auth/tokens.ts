import { createHash, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

export type SessionKind = "user" | "staff";
export type AuthNodeEnv = "development" | "test" | "production";

const TOKEN_BYTES = 32;

/** A 256-bit secret, base64url encoded, as the browser sees it in a cookie. */
export function createToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** The database stores no raw secrets: only the SHA-256 of the token (ADR 0018). */
export function hashToken(token: string): Uint8Array {
  return createHash("sha256").update(token).digest();
}

/** A per-session CSRF token: HMAC-SHA-256 of the session ID with the server key. */
export function createCsrfToken(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(`session:${sessionId}`).digest("base64url");
}

export const SESSION_LIFETIMES = {
  user: {
    idleMs: 30 * 24 * 60 * 60 * 1_000,
    absoluteMs: 90 * 24 * 60 * 60 * 1_000,
    reauthHours: 24,
  },
  staff: {
    idleMs: 2 * 60 * 60 * 1_000,
    absoluteMs: 12 * 60 * 60 * 1_000,
    reauthHours: 12,
  },
} as const;

export function sessionCookieName(kind: SessionKind, nodeEnv: AuthNodeEnv): string {
  if (nodeEnv === "production") {
    return kind === "user" ? "__Host-bl_session" : "__Host-bl_staff";
  }

  return kind === "user" ? "bl_session" : "bl_staff";
}

export function challengeCookieName(nodeEnv: AuthNodeEnv): string {
  return nodeEnv === "production" ? "__Host-bl_login" : "bl_login";
}

export interface CookieOptions {
  readonly maxAge?: number;
  readonly path?: string;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: "Lax" | "Strict";
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${value}`, `Path=${options.path ?? "/"}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.trunc(options.maxAge))}`);
  }

  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }

  if (options.secure === true) {
    parts.push("Secure");
  }

  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

export function parseCookieHeader(header: string | null): Readonly<Record<string, string>> {
  if (header === null || header === "") {
    return {};
  }

  const cookies: Record<string, string> = {};

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (name !== "") {
      cookies[name] = decodeURIComponent(value);
    }
  }

  return cookies;
}

/** Only same-origin relative paths are valid post-login destinations (no open redirect). */
export function safeReturnTo(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  const hasControlCharacter = [...trimmed].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    hasControlCharacter
  ) {
    return null;
  }

  try {
    const url = new URL(trimmed, "https://bulletin.invalid");

    if (url.origin !== "https://bulletin.invalid") {
      return null;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/** The client IP from the trusted reverse proxy, or null when it is unavailable. */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const candidate =
    forwarded?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip")?.trim() ?? null;

  return candidate !== null && isIP(candidate) !== 0 ? candidate : null;
}

export function userAgent(request: Request): string | null {
  const value = request.headers.get("user-agent")?.trim();
  return value === undefined || value === "" ? null : value;
}
