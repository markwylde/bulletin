import { describe, expect, test } from "bun:test";
import { createDatabaseCheck, readMaxConnections, startService } from "@bulletin/config/server";
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
});
