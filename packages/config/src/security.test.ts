import { describe, expect, test } from "bun:test";
import {
  applySecurityHeaders,
  contentSecurityPolicy,
  createCspNonce,
  securityHeaders,
} from "./security.ts";

describe("security headers", () => {
  test("builds a nonce-based CSP with frame-ancestors none", () => {
    const csp = contentSecurityPolicy({
      nonce: "abc123",
      nodeEnv: "development",
      connectSrc: ["http://auth.bulletin.localhost:8080"],
      frameSrc: ["https://www.youtube-nocookie.com", "https://player.vimeo.com"],
      imgSrc: ["http://files.bulletin.localhost:8080"],
    });

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'nonce-abc123'");
    expect(csp).toContain("connect-src 'self' http://auth.bulletin.localhost:8080");
    expect(csp).toContain("img-src 'self' data: http://files.bulletin.localhost:8080");
    expect(csp).toContain("frame-src https://www.youtube-nocookie.com https://player.vimeo.com");
    expect(csp).not.toContain("frame-src *");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("strict-transport-security");
  });

  test("frames nothing when no embed provider is allowlisted", () => {
    const csp = contentSecurityPolicy({ nonce: "n", nodeEnv: "development" });

    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("adds nosniff, referrer policy and production HSTS", () => {
    const development = securityHeaders({ nonce: "n", nodeEnv: "development" });
    expect(development.get("x-content-type-options")).toBe("nosniff");
    expect(development.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(development.get("strict-transport-security")).toBeNull();

    const production = securityHeaders({ nonce: "n", nodeEnv: "production" });
    expect(production.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });

  test("applies headers without dropping cookies or the body", async () => {
    const original = Response.json(
      { ok: true },
      { headers: { "set-cookie": "bl_session=one; Path=/" } },
    );
    const secured = applySecurityHeaders(original, {
      nonce: "n",
      nodeEnv: "test",
    });

    expect(secured.status).toBe(200);
    expect(await secured.json()).toEqual({ ok: true });
    expect(secured.headers.get("set-cookie")).toBe("bl_session=one; Path=/");
    expect(secured.headers.get("content-security-policy")).toContain("'nonce-n'");
  });

  test("generates distinct nonces", () => {
    expect(createCspNonce()).not.toBe(createCspNonce());
  });
});
