import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_METRICS_PORT } from "@bulletin/config/metrics";

const root = join(import.meta.dir, "..", "..");

async function read(path: string): Promise<string> {
  return Bun.file(join(root, path)).text();
}

/** ADR 0020: every service exposes `/metrics` on its internal port, never through the proxy. */
describe("metrics endpoints", () => {
  for (const app of ["user-api", "staff-api", "workers", "plugin-host"]) {
    test(`${app} serves the metrics endpoint`, async () => {
      expect(await read(`apps/${app}/src/index.ts`)).toContain("metricsPort: metricsPortFromEnv()");
    });
  }

  test("user-app starts its metrics listener from the middleware", async () => {
    expect(await read("apps/user-app/src/middleware.ts")).toContain("startUserAppMetrics()");
  });

  test("workers export queue and outbox metrics", async () => {
    expect(await read("apps/workers/src/index.ts")).toContain("registerQueueCollector(sql)");
  });

  test("the public proxy never routes the metrics port", async () => {
    const caddyfile = await read("apps/proxy/Caddyfile");

    expect(caddyfile).not.toContain(String(DEFAULT_METRICS_PORT));
    expect(caddyfile).not.toContain("/metrics");
  });
});
