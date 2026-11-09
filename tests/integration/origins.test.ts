import { describe, expect, test } from "bun:test";
import { authIssuer, httpPort, type StackHost, stackOrigin } from "@bulletin/test-utils/urls";

// Run against the running compose stack:
//   docker compose up -d
//   bun run test:integration

const ENABLED = Bun.env.BULLETIN_INTEGRATION === "1";
const PORT = httpPort();

const ORIGIN_PATHS: Readonly<Record<StackHost, string>> = {
  user: "/",
  staff: "/",
  files: "/health/live",
  plugins: "/",
  auth: "/",
};

const integrationDescribe = ENABLED ? describe : describe.skip;

integrationDescribe("compose origins", () => {
  for (const [host, path] of Object.entries(ORIGIN_PATHS) as Array<[StackHost, string]>) {
    test(`${host} origin on port ${PORT} responds through the proxy`, async () => {
      const response = await fetch(`${stackOrigin(host)}${path}`);

      expect(response.status).toBe(200);
    });
  }

  test("each app's /api/* route reaches its own API", async () => {
    const userApi = await fetch(`${stackOrigin("user")}/api/auth/session`);
    expect(userApi.status).toBe(200);
    expect(await userApi.json()).toMatchObject({ authenticated: false, kind: "user" });

    const staffApi = await fetch(`${stackOrigin("staff")}/api/auth/session`);
    expect(staffApi.status).toBe(200);
    expect(await staffApi.json()).toMatchObject({ authenticated: false, kind: "staff" });
  });

  test("app origins expose liveness and readiness", async () => {
    for (const host of ["user", "staff"] as const) {
      const live = await fetch(`${stackOrigin(host)}/health/live`);
      expect(live.status).toBe(200);

      const ready = await fetch(`${stackOrigin(host)}/health/ready`);
      expect(ready.status).toBe(200);
    }
  });

  test("the auth origin serves the mock's discovery document", async () => {
    const issuer = authIssuer();
    const response = await fetch(`${issuer}/.well-known/openid-configuration`);
    expect(response.status).toBe(200);

    const discovery = (await response.json()) as {
      issuer?: string;
      authorization_endpoint?: string;
    };
    expect(discovery.issuer).toBe(issuer);
    expect(discovery.authorization_endpoint).toBe(`${issuer}/authorize`);
  });
});
