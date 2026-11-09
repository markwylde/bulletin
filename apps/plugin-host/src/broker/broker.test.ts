import { describe, expect, test } from "bun:test";
import { createLogger } from "@bulletin/config";
import { Broker, type BrokerDatabase, type BrokerEgress } from "./broker.ts";
import type { QueryResult } from "./database.ts";
import { EgressDeniedError, type EgressRequest, type EgressResponse } from "./egress.ts";
import { RpcError } from "./protocol.ts";
import type { AllowedStatement } from "./sql.ts";

interface RecordedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly statement: AllowedStatement;
}

interface FakeDatabase extends BrokerDatabase {
  readonly queries: RecordedQuery[];
  result: QueryResult;
  closed: boolean;
  failWith: Error | undefined;
}

function createDatabase(): FakeDatabase {
  const database: FakeDatabase = {
    schema: "plugin_sandbox_demo",
    functions: new Set(["note_count"]),
    ready: true,
    queries: [],
    result: { rows: [{ id: "1" }], rowCount: 1, command: "select" },
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

      return { ...database.result, command: statement.command };
    },
    async close() {
      database.closed = true;
    },
  };

  return database;
}

interface FakeEgress extends BrokerEgress {
  readonly requests: EgressRequest[];
  failWith: Error | undefined;
}

function createEgress(): FakeEgress {
  const egress: FakeEgress = {
    requests: [],
    failWith: undefined,
    async request(input: EgressRequest): Promise<EgressResponse> {
      egress.requests.push(input);

      if (egress.failWith !== undefined) {
        throw egress.failWith;
      }

      return {
        url: input.url,
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "ok",
      };
    },
  };

  return egress;
}

function createBroker(): {
  broker: Broker;
  database: FakeDatabase;
  egress: FakeEgress;
  lines: string[];
} {
  const lines: string[] = [];
  const database = createDatabase();
  const egress = createEgress();
  const logger = createLogger({
    service: "broker-test",
    level: "debug",
    sink: (line) => lines.push(line),
  });
  return { broker: new Broker({ database, egress, logger }), database, egress, lines };
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

  test("refuses an oversized query result before it reaches the socket", async () => {
    const { broker, database } = createBroker();
    database.result = {
      rows: [{ body: "x".repeat(600_000) }],
      rowCount: 1,
      command: "select",
    };

    await expectRpcError(
      broker.handle({
        method: "db.query",
        pluginId: "sandbox-demo",
        params: { sql: "SELECT * FROM notes" },
      }),
      -32000,
    );
    expect(broker.stats()).toMatchObject({ queries: 0, denials: 1 });
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

  test("forwards an allowed egress request", async () => {
    const { broker, egress } = createBroker();

    const result = await broker.handle({
      method: "http.fetch",
      pluginId: "sandbox-demo",
      params: {
        url: "https://example.com/data",
        method: "POST",
        headers: { accept: "application/json" },
        body: "{}",
      },
    });

    expect(result).toMatchObject({ status: 200, body: "ok" });
    expect(egress.requests).toEqual([
      {
        url: "https://example.com/data",
        method: "POST",
        headers: { accept: "application/json" },
        body: "{}",
      },
    ]);
    expect(broker.stats()).toMatchObject({ fetches: 1, denials: 0, failures: 0 });
  });

  test("maps egress denials and failures to JSON-RPC errors", async () => {
    const { broker, egress } = createBroker();
    egress.failWith = new EgressDeniedError("host", "Host is not on the allowlist");

    await expectRpcError(
      broker.handle({
        method: "http.fetch",
        pluginId: "sandbox-demo",
        params: { url: "https://evil.example/" },
      }),
      -32000,
    );
    expect(broker.stats().denials).toBe(1);

    egress.failWith = new Error("socket reset");
    await expectRpcError(
      broker.handle({
        method: "http.fetch",
        pluginId: "sandbox-demo",
        params: { url: "https://example.com/" },
      }),
      -32603,
    );
    expect(broker.stats().failures).toBe(1);
  });

  test("rejects malformed egress params", async () => {
    const { broker } = createBroker();

    await expectRpcError(
      broker.handle({ method: "http.fetch", pluginId: "sandbox-demo", params: {} }),
      -32602,
    );
    await expectRpcError(
      broker.handle({
        method: "http.fetch",
        pluginId: "sandbox-demo",
        params: { url: "https://example.com/", headers: { accept: 1 } },
      }),
      -32602,
    );
    await expectRpcError(
      broker.handle({
        method: "http.fetch",
        pluginId: "sandbox-demo",
        params: { url: "https://example.com/", body: {} },
      }),
      -32602,
    );
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
