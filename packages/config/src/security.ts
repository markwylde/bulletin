import { randomBytes } from "node:crypto";

export type SecurityNodeEnv = "development" | "test" | "production";

export interface SecurityHeadersOptions {
  readonly nonce: string;
  readonly nodeEnv: SecurityNodeEnv;
  /** Extra origins allowed by `connect-src` (the DarkAuth issuer for browser apps). */
  readonly connectSrc?: readonly string[];
}

export interface SecurityHeadersConfig {
  readonly nodeEnv: SecurityNodeEnv;
  readonly connectSrc?: readonly string[];
}

export function createCspNonce(): string {
  return randomBytes(16).toString("base64");
}

export function contentSecurityPolicy(options: SecurityHeadersOptions): string {
  const connectSrc = ["'self'", ...(options.connectSrc ?? [])].join(" ");

  return [
    "default-src 'none'",
    `connect-src ${connectSrc}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'nonce-${options.nonce}'`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

export function securityHeaders(options: SecurityHeadersOptions): Headers {
  const headers = new Headers({
    "content-security-policy": contentSecurityPolicy(options),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  });

  if (options.nodeEnv === "production") {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }

  return headers;
}

/** Adds the app-origin security headers to a response without changing its body. */
export function applySecurityHeaders(
  response: Response,
  options: SecurityHeadersOptions,
): Response {
  const headers = new Headers(response.headers);

  for (const [name, value] of securityHeaders(options)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
