import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { ConnectionBudgetError } from "./connections.ts";
import { createServiceSql, type RunningService, startService } from "./server.ts";

const running: RunningService[] = [];

afterEach(async () => {
  for (const service of running.splice(0)) {
    await service.shutdown();
  }
});

async function start(
  options: Omit<Parameters<typeof startService>[0], "installSignalHandlers">,
): Promise<{ service: RunningService; base: string }> {
  const service = await startService({ ...options, installSignalHandlers: false });
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
