import { describe, expect, test } from "bun:test";
import { createLogger } from "@bulletin/config";
import { Broker, type BrokerDatabase } from "./broker.ts";
import type { QueryResult } from "./database.ts";
import { RpcError } from "./protocol.ts";
import type { AllowedStatement } from "./sql.ts";

interface RecordedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly statement: AllowedStatement;
}

interface FakeDatabase extends BrokerDatabase {
  readonly queries: RecordedQuery[];
  closed: boolean;
  failWith: Error | undefined;
}

function createDatabase(): FakeDatabase {
  const database: FakeDatabase = {
    schema: "plugin_sandbox_demo",
    functions: new Set(["note_count"]),
    ready: true,
    queries: [],
    closed: false,
    failWith: undefined,
    async query(
      sql: string,
      params: readonly unknown[],
      statement: AllowedStatement,
    ): Promise<QueryResult> {
      database.queries.push({ sql, params, statement });

      if (database.failWith !== undefined) {
        throw database.failWith;
      }

      return { rows: [{ id: "1" }], rowCount: 1, command: statement.command };
    },
    async close() {
      database.closed = true;
    },
  };

  return database;
}

function createBroker(): {
  broker: Broker;
  database: FakeDatabase;
  lines: string[];
} {
  const lines: string[] = [];
  const database = createDatabase();
  const logger = createLogger({
    service: "broker-test",
    level: "debug",
    sink: (line) => lines.push(line),
  });
  return { broker: new Broker({ database, logger }), database, lines };
}

async function expectRpcError(promise: Promise<unknown>, code: number): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(code);
    return;
  }

  throw new Error("Expected an RpcError");
}

describe("broker dispatch", () => {
  test("runs an allowed query and reports the result", async () => {
    const { broker, database } = createBroker();

    const result = await broker.handle({
      method: "db.query",
      pluginId: "sandbox-demo",
      params: { sql: "SELECT * FROM notes WHERE id = $1", params: ["1"] },
    });

    expect(result).toEqual({ rows: [{ id: "1" }], rowCount: 1, command: "select" });
    expect(database.queries).toEqual([
      {
        sql: "SELECT * FROM notes WHERE id = $1",
        params: ["1"],
        statement: { command: "select", hasReturning: false },
      },
    ]);
    expect(broker.stats()).toMatchObject({ queries: 1, denials: 0, failures: 0 });
  });

  test("denies DDL before it reaches the database", async () => {
    const { broker, database } = createBroker();

    await expectRpcError(
      broker.handle({
        method: "db.query",
        pluginId: "sandbox-demo",
        params: { sql: "CREATE TABLE notes (id int)" },
      }),
      -32000,
    );

    expect(database.queries).toEqual([]);
    expect(broker.stats()).toMatchObject({ queries: 0, denials: 1 });
  });

  test("denies core reads and side-effecting functions", async () => {
    const { broker, database } = createBroker();

    await expectRpcError(
      broker.handle({
        method: "db.query",
        pluginId: "sandbox-demo",
        params: { sql: "SELECT * FROM core.cache_tags" },
      }),
      -32000,
    );
    await expectRpcError(
      broker.handle({
        method: "db.query",
        pluginId: "sandbox-demo",
        params: { sql: "SELECT pg_sleep(10)" },
      }),
      -32000,
    );

    expect(database.queries).toEqual([]);
    expect(broker.stats().denials).toBe(2);
  });

  test("rejects malformed query params", async () => {
    const { broker } = createBroker();

    await expectRpcError(
      broker.handle({ method: "db.query", pluginId: "sandbox-demo", params: {} }),
      -32602,
    );
    await expectRpcError(
      broker.handle({
        method: "db.query",
        pluginId: "sandbox-demo",
        params: { sql: "SELECT 1", params: [{ nested: true }] },
      }),
      -32602,
    );
  });

  test("maps database failures to an internal error without leaking details", async () => {
    const { broker, database } = createBroker();
    database.failWith = new Error("relation secret_table does not exist");

    try {
      await broker.handle({
        method: "db.query",
        pluginId: "sandbox-demo",
        params: { sql: "SELECT * FROM notes" },
      });
      throw new Error("Expected an RpcError");
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(-32603);
      expect((error as RpcError).message).toBe("Query failed");
      expect((error as RpcError).message).not.toContain("secret_table");
    }

    expect(broker.stats().failures).toBe(1);
  });

  test("logs plugin messages at the requested level", async () => {
    const { broker, lines } = createBroker();

    const result = await broker.handle({
      method: "log",
      pluginId: "sandbox-demo",
      params: { level: "warn", message: "careful", fields: { rows: 3 } },
    });

    expect(result).toBeNull();
    const entry = lines
      .map((line) => JSON.parse(line))
      .find((line) => line.message === "plugin.log");
    expect(entry).toMatchObject({
      level: "warn",
      message: "plugin.log",
      schema: "plugin_sandbox_demo",
      fields: { rows: 3 },
    });
    expect(broker.stats().logs).toBe(1);
  });

  test("rejects invalid log calls", async () => {
    const { broker } = createBroker();

    await expectRpcError(
      broker.handle({
        method: "log",
        pluginId: "sandbox-demo",
        params: { level: "trace", message: "x" },
      }),
      -32602,
    );
    await expectRpcError(
      broker.handle({
        method: "log",
        pluginId: "sandbox-demo",
        params: { level: "info", message: "x".repeat(5_000) },
      }),
      -32602,
    );
    await expectRpcError(
      broker.handle({
        method: "log",
        pluginId: "sandbox-demo",
        params: { level: "info", message: "x", fields: [] },
      }),
      -32602,
    );
  });

  test("rejects unknown methods and closes the database", async () => {
    const { broker, database } = createBroker();

    await expectRpcError(
      broker.handle({ method: "core.read", pluginId: "sandbox-demo", params: {} }),
      -32601,
    );

    await broker.close();
    expect(database.closed).toBe(true);
  });
});
