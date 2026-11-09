import { describe, expect, test } from "bun:test";

// Run against the running compose stack:
//   docker compose up -d
//   bun run test:integration

const ENABLED = Bun.env.BULLETIN_INTEGRATION === "1";

const ORIGIN_HOSTS = [
  "bulletin.localhost",
  "staff.bulletin.localhost",
  "files.bulletin.localhost",
  "plugins.bulletin.localhost",
  "auth.bulletin.localhost",
] as const;

const integrationDescribe = ENABLED ? describe : describe.skip;

integrationDescribe("compose origins", () => {
  for (const host of ORIGIN_HOSTS) {
    test(`${host}:8080 responds through the proxy`, async () => {
      const response = await fetch(`http://${host}:8080/`);

      expect(response.status).toBe(200);
    });
  }

  test("each app's /api/* route reaches its own API", async () => {
    const userApi = await fetch("http://bulletin.localhost:8080/api/ping");
    expect(userApi.status).toBe(200);
    expect(await userApi.json()).toMatchObject({ service: "user-api" });

    const staffApi = await fetch("http://staff.bulletin.localhost:8080/api/ping");
    expect(staffApi.status).toBe(200);
    expect(await staffApi.json()).toMatchObject({ service: "staff-api" });
  });

  test("app origins expose liveness and readiness", async () => {
    for (const host of ["bulletin.localhost", "staff.bulletin.localhost"]) {
      const live = await fetch(`http://${host}:8080/health/live`);
      expect(live.status).toBe(200);

      const ready = await fetch(`http://${host}:8080/health/ready`);
      expect(ready.status).toBe(200);
    }
  });

  test("the auth origin serves the mock's discovery document", async () => {
    const response = await fetch(
      "http://auth.bulletin.localhost:8080/.well-known/openid-configuration",
    );
    expect(response.status).toBe(200);

    const discovery = (await response.json()) as {
      issuer?: string;
      authorization_endpoint?: string;
    };
    expect(discovery.issuer).toBe("http://auth.bulletin.localhost:8080");
    expect(discovery.authorization_endpoint).toBe("http://auth.bulletin.localhost:8080/authorize");
  });
});
