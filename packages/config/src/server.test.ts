import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { ConnectionBudgetError } from "./connections.ts";
import { createLogger } from "./log.ts";
import { METRIC_FAMILIES, metrics, parsePrometheusText } from "./metrics.ts";
import { createServiceSql, listenSqlFromEnv, type RunningService, startService } from "./server.ts";

const running: RunningService[] = [];

afterEach(async () => {
  for (const service of running.splice(0)) {
    await service.shutdown();
  }
});

async function start(
  options: Omit<Parameters<typeof startService>[0], "installSignalHandlers">,
): Promise<{ service: RunningService; base: string }> {
  const logger = options.logger ?? createLogger({ service: "test", sink: () => undefined });
  const service = await startService({
    ...options,
    hostname: options.hostname ?? "127.0.0.1",
    logger,
    installSignalHandlers: false,
  });
  running.push(service);
  const port = service.server.port;

  if (port === undefined) {
    throw new Error("server did not bind a port");
  }

  return { service, base: `http://127.0.0.1:${port}` };
}

describe("shared service lifecycle", () => {
  test("serves liveness and readiness with per-check results", async () => {
    const { base } = await start({
      service: "test",
      port: 0,
      fetch: () => new Response("ok"),
      checks: [{ name: "database", check: () => true }],
    });

    const live = await fetch(`${base}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "ok", service: "test" });

    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: "ok",
      checks: { database: true },
    });
  });

  test("fails readiness while liveness stays up when a check fails", async () => {
    const { base } = await start({
      service: "test",
      port: 0,
      fetch: () => new Response("ok"),
      checks: [
        { name: "database", check: () => false },
        {
          name: "listener",
          check: () => {
            throw new Error("listener down");
          },
        },
      ],
    });

    expect((await fetch(`${base}/health/live`)).status).toBe(200);

    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      status: "unavailable",
      checks: { database: false, listener: false },
    });
  });

  test("refuses public requests while a request gate is closed and keeps /health/* up", async () => {
    let restored = false;
    let dispatched = 0;
    const { base } = await start({
      service: "test",
      port: 0,
      fetch: () => {
        dispatched += 1;
        return new Response("ok");
      },
      checks: [{ name: "journal", check: () => restored }],
      requestGates: [{ name: "journal", check: () => restored }],
    });

    for (const path of ["/", "/api/me", "/api/v1/forums"]) {
      const refused = await fetch(`${base}${path}`, { headers: { cookie: "bl_session=x" } });
      expect(refused.status).toBe(503);
      expect(refused.headers.get("cache-control")).toBe("no-store");
      expect(refused.headers.get("retry-after")).toBe("30");
      expect(await refused.json()).toEqual({ code: "restoring" });
    }

    expect(dispatched).toBe(0);
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect((await fetch(`${base}/health/ready`)).status).toBe(503);

    restored = true;
    // A closed result is reused for a second, so a request flood is not a storage flood.
    await Bun.sleep(1_100);
    const served = await fetch(`${base}/api/me`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("ok");
    expect(dispatched).toBe(1);
  });

  test("keeps request metric labels bounded under arbitrary paths and methods", async () => {
    metrics.resetValues();
    const { base } = await start({
      service: "test",
      port: 0,
      routes: ["/api/items/:id"],
      fetch: (request) => {
        const { pathname } = new URL(request.url);

        if (pathname.startsWith("/api/items/")) {
          return new Response("ok");
        }

        // Authentication before routing: any /api path answers 401, so the status alone
        // cannot tell a real route from a made-up one.
        return pathname.startsWith("/api/")
          ? new Response("unauthenticated", { status: 401 })
          : new Response("not found", { status: 404 });
      },
    });

    for (let index = 0; index < 300; index += 1) {
      const tag = crypto.randomUUID().slice(0, 6);
      await fetch(`${base}/x${index}/${tag}`);
      await fetch(`${base}/api/k${index}-${tag}`, { method: index % 2 === 0 ? "GET" : "POST" });
      await fetch(`${base}/api/items/${index}`);
      await fetch(`${base}/api/items/${index}`, { method: `M${index}` }).catch(() => undefined);
    }

    const samples = parsePrometheusText(await metrics.expose()).filter(
      (sample) => sample.name === `${METRIC_FAMILIES.requestDuration}_count`,
    );
    const routes = new Set(samples.map((sample) => sample.labels.route));
    const methods = new Set(samples.map((sample) => sample.labels.method));

    expect(routes.has("/api/items/:id")).toBe(true);
    expect(routes.has("unmatched")).toBe(true);
    expect(routes.size).toBeLessThanOrEqual(102);
    expect(
      [...methods].every((method) =>
        ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "other"].includes(
          method ?? "",
        ),
      ),
    ).toBe(true);
    metrics.resetValues();
  }, 30_000);

  test("lets an in-flight request finish before shutdown resolves", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, base } = await start({
      service: "test",
      port: 0,
      async fetch() {
        await gate;
        return new Response("finished");
      },
    });

    const pending = fetch(`${base}/slow`);
    await Bun.sleep(5);

    const shutdown = service.shutdown();
    release?.();

    const response = await pending;
    expect(await response.text()).toBe("finished");
    await shutdown;
  });

  test("waits for a streamed response body to finish", async () => {
    let finishStream: (() => void) | undefined;
    const { service, base } = await start({
      service: "test",
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            finishStream = () => {
              controller.enqueue(new TextEncoder().encode("second"));
              controller.close();
            };
          },
        });

        return new Response(stream);
      },
      drainTimeoutMs: 2_000,
    });

    const response = await fetch(`${base}/stream`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    expect(await reader?.read()).toMatchObject({ done: false });

    let shutdownFinished = false;
    const shutdown = service.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Bun.sleep(20);
    expect(shutdownFinished).toBe(false);

    finishStream?.();
    while ((await reader?.read())?.done === false) {
      // Drain the rest of the stream.
    }
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });

  test("stops after the drain timeout", async () => {
    const { service, base } = await start({
      service: "test",
      port: 0,
      fetch: () => new Promise<Response>(() => undefined),
      drainTimeoutMs: 20,
    });

    const pending = fetch(`${base}/slow`).catch(() => null);
    await Bun.sleep(5);

    const started = Date.now();
    await service.shutdown();
    expect(Date.now() - started).toBeLessThan(500);
    await pending;
  });

  test("applies one deadline to the worker shutdown callback", async () => {
    const { service } = await start({
      service: "test",
      port: 0,
      fetch: () => new Response("ok"),
      drainTimeoutMs: 20,
      onShutdown: () => new Promise<void>(() => undefined),
    });

    const started = Date.now();
    await service.shutdown();
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("creates SQL pools with the budgeted pool size", async () => {
    const sql = createServiceSql("staff-api", "postgres://bulletin@127.0.0.1:1/postgres");

    try {
      expect(sql.options.max).toBe(5);
    } finally {
      await sql.close();
    }
  });

  test("emits redacted structured request logs with correlation IDs", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      service: "test",
      level: "debug",
      sink: (line) => lines.push(line),
      now: () => new Date("2026-11-09T12:00:00.000Z"),
    });
    const { base } = await start({
      service: "test",
      port: 0,
      fetch: () => new Response("ok"),
      logger,
    });

    await fetch(`${base}/jane@example.com`);

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(2);
    expect(records[0]?.requestId).toBeString();
    expect(records[0]?.message).toBe("request.started");
    expect(records[1]?.status).toBe(200);
    expect(lines.join("\n")).not.toContain("jane@example.com");
  });

  test("refuses to start an over-budget service", async () => {
    const sql = new SQL("postgres://bulletin@127.0.0.1:1/postgres");

    try {
      await expect(
        startService({
          service: "user-api",
          port: 0,
          fetch: () => new Response("ok"),
          installSignalHandlers: false,
          budget: { sql, service: "user-api", maxConnections: 50 },
        }),
      ).rejects.toBeInstanceOf(ConnectionBudgetError);
    } finally {
      await sql.close();
    }
  });
});

describe("listenSqlFromEnv (ADR 0003)", () => {
  test("reuses the query client unless a direct LISTEN URL is configured", async () => {
    const pool = new SQL("postgres://user@127.0.0.1:1/db", { max: 1 });

    expect(listenSqlFromEnv(pool, {})).toBe(pool);
    expect(listenSqlFromEnv(pool, { LISTEN_DATABASE_URL: " " })).toBe(pool);
    const direct = listenSqlFromEnv(pool, {
      LISTEN_DATABASE_URL: "postgres://user@127.0.0.1:2/db",
    });
    expect(direct).not.toBe(pool);
    await direct.close();
    await pool.close();
  });
});
