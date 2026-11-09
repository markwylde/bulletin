import { describe, expect, test } from "bun:test";

// Run against the running compose stack:
//   docker compose up -d
//   BULLETIN_INTEGRATION=1 bun test tests/integration/security-headers.test.ts

const ENABLED = Bun.env.BULLETIN_INTEGRATION === "1";
const integrationDescribe = ENABLED ? describe : describe.skip;

const APPS = [
  {
    name: "user-app",
    url: Bun.env.BULLETIN_BASE_URL ?? "http://bulletin.localhost:8080",
    apiPath: "/api/auth/session",
  },
  {
    name: "staff-app",
    url: Bun.env.BULLETIN_STAFF_BASE_URL ?? "http://staff.bulletin.localhost:8080",
    apiPath: "/api/auth/session",
  },
] as const;

function nonceFrom(csp: string | null): string {
  const nonce = csp === null ? null : /'nonce-([^']+)'/.exec(csp)?.[1];

  if (nonce === undefined || nonce === null) {
    throw new Error(`CSP has no nonce: ${csp ?? "<missing>"}`);
  }

  return nonce;
}

function assertCommonHeaders(headers: Headers): void {
  expect(headers.get("x-content-type-options")).toBe("nosniff");
  expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  expect(headers.get("strict-transport-security")).toBeNull();
  const csp = headers.get("content-security-policy");
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
}

integrationDescribe("security headers", () => {
  for (const app of APPS) {
    test(`${app.name} pages carry the CSP nonce and security headers`, async () => {
      const response = await fetch(app.url);
      expect(response.status).toBe(200);
      assertCommonHeaders(response.headers);

      const nonce = nonceFrom(response.headers.get("content-security-policy"));
      const body = await response.text();
      expect(body).toContain(`nonce="${nonce}"`);
    });

    test(`${app.name} API responses carry security headers`, async () => {
      const response = await fetch(`${app.url}${app.apiPath}`);
      expect(response.status).toBe(200);
      assertCommonHeaders(response.headers);
      expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");

      const live = await fetch(`${app.url.replace(/\/$/, "")}/health/live`);
      expect(live.status).toBe(200);
      assertCommonHeaders(live.headers);
    });
  }

  test("the user-app callback transit route carries security headers", async () => {
    const base = Bun.env.BULLETIN_BASE_URL ?? "http://bulletin.localhost:8080";
    const response = await fetch(`${base}/auth/callback`);
    expect(response.status).toBe(200);
    assertCommonHeaders(response.headers);
    expect(response.headers.get("content-security-policy")).toMatch(/'nonce-[^']+'/);
  });
});
