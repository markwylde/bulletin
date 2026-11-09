import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  createDatabaseCheck,
  createListenerCheck,
  readMaxConnections,
  startService,
} from "@bulletin/config/server";
import { migrationsCurrent } from "@bulletin/db/migrate";
import { SQL } from "bun";

const databaseUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = databaseUrl === undefined ? describe.skip : describe;

integrationDescribe("service health", () => {
  test("database failure lowers readiness but not liveness", async () => {
    if (databaseUrl === undefined) {
      return;
    }

    const sql = new SQL(databaseUrl);
    const service = await startService({
      service: "health-test",
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
      checks: [createDatabaseCheck(sql)],
      installSignalHandlers: false,
    });
    const port = service.server.port;

    if (port === undefined) {
      throw new Error("server did not bind a port");
    }

    const base = `http://127.0.0.1:${port}`;
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);

    await sql.close();

    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect((await fetch(`${base}/health/ready`)).status).toBe(503);

    await service.shutdown();
  });

  test("reads Postgres max_connections", async () => {
    if (databaseUrl === undefined) {
      return;
    }

    const sql = new SQL(databaseUrl);

    try {
      expect(await readMaxConnections(sql)).toBeGreaterThan(0);
    } finally {
      await sql.close();
    }
  });

  test("stale or missing migrations fail readiness", async () => {
    if (databaseUrl === undefined) {
      return;
    }

    const sql = new SQL(databaseUrl);
    const service = await startService({
      service: "health-test",
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("ok"),
      checks: [
        createDatabaseCheck(sql),
        { name: "migrations", check: () => migrationsCurrent(sql) },
      ],
      installSignalHandlers: false,
    });
    const port = service.server.port;

    if (port === undefined) {
      throw new Error("server did not bind a port");
    }

    try {
      expect((await fetch(`http://127.0.0.1:${port}/health/ready`)).status).toBe(503);
    } finally {
      await service.shutdown();
      await sql.close();
    }
  });

  test("listener check follows the dedicated LISTEN connection", async () => {
    if (databaseUrl === undefined) {
      return;
    }

    const sql = new SQL(databaseUrl);
    const listener = await createListenerCheck(sql);

    try {
      expect(await listener.check()).toBe(true);
      expect(await Promise.all([listener.check(), listener.check(), listener.check()])).toEqual([
        true,
        true,
        true,
      ]);
      await listener.close();
      expect(await listener.check()).toBe(false);
    } finally {
      await listener.close();
      await sql.close();
    }
  });

  test("user-app refuses to start when its declared replicas exceed the budget", async () => {
    if (databaseUrl === undefined) {
      return;
    }

    const userAppUrl = new URL(databaseUrl);
    userAppUrl.username = "user_app";
    userAppUrl.password = "";
    const configUrl = new URL("../../apps/user-app/astro.config.mjs", import.meta.url).href;
    const script = `
      try {
        const module = await import(${JSON.stringify(configUrl)});
        await module.default.integrations[0].hooks["astro:config:setup"]({ command: "dev" });
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    `;

    const child = Bun.spawn(["bun", "-e", script], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: {
        ...Bun.env,
        NODE_ENV: "development",
        DATABASE_URL: userAppUrl.toString(),
        BULLETIN_REPLICAS: "user-api=100",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => child.kill(), 15_000);
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    clearTimeout(timer);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Connection budget exceeded");
  }, 20_000);
});
