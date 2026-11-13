import { describe, expect, test } from "bun:test";
import { createLogger } from "@bulletin/config";
import {
  Broker,
  type BrokerDatabase,
  type BrokerEgress,
  type PluginGrants,
  type PluginGrantsLoader,
} from "./broker.ts";
import { CacheInvalidator } from "./cache.ts";
import { type CoreCall, CoreDeniedError, type CoreForwarder } from "./core.ts";
import type { QueryResult } from "./database.ts";
import { EgressDeniedError, type EgressRequest, type EgressResponse } from "./egress.ts";
import type { BrokerLimitOptions } from "./limits.ts";

const cacheLogger = createLogger({ service: "cache-broker-test", level: "error", sink: () => {} });

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

const ALL_GRANTS: PluginGrants = {
  capabilities: ["db", "egress", "core.read", "core.write", "cache.invalidate"],
  egressHosts: ["example.com"],
};

function createBroker(
  options: {
    limits?: BrokerLimitOptions;
    core?: CoreForwarder;
    cache?: CacheInvalidator;
    isActive?: (pluginId: string) => Promise<boolean>;
    grants?: PluginGrantsLoader;
  } = {},
): {
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
  return {
    broker: new Broker({
      database,
      egress,
      logger,
      ...(options.core === undefined ? {} : { core: options.core }),
      ...(options.cache === undefined ? {} : { cache: options.cache }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.isActive === undefined ? {} : { isActive: options.isActive }),
      grants: options.grants ?? (async () => ALL_GRANTS),
    }),
    database,
    egress,
    lines,
  };
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
        approvedHosts: ["example.com"],
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

  test("rate-limits database statements per plugin", async () => {
    const { broker } = createBroker({ limits: { dbStatementsPerSecond: 1 } });

    await expect(
      broker.handle({
        method: "db.query",
        pluginId: "sandbox-demo",
        params: { sql: "SELECT 1" },
      }),
    ).resolves.toBeDefined();

    try {
      await broker.handle({
        method: "db.query",
        pluginId: "sandbox-demo",
        params: { sql: "SELECT 2" },
      });
      throw new Error("Expected a rate-limit denial");
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(-32000);
      expect((error as RpcError).data).toMatchObject({ reason: "rate" });
    }

    expect(broker.stats().rateLimited).toBe(1);
    expect(broker.stats().denials).toBe(1);
  });

  test("queues at the database concurrency limit and fails only the waiting call", async () => {
    const { broker, database } = createBroker({
      limits: { maxConcurrentDb: 1, dbStatementsPerSecond: 100, waitTimeoutMs: 20 },
    });
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    database.query = async () => {
      await blocked;
      return { rows: [], rowCount: 0, command: "select" };
    };

    const first = broker.handle({
      method: "db.query",
      pluginId: "sandbox-demo",
      params: { sql: "SELECT 1" },
    });
    await Bun.sleep(5);

    try {
      await broker.handle({
        method: "db.query",
        pluginId: "sandbox-demo",
        params: { sql: "SELECT 2" },
      });
      throw new Error("Expected a concurrency denial");
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).data).toMatchObject({ reason: "concurrency" });
    }

    release();
    await expect(first).resolves.toBeDefined();
    expect(broker.stats().concurrencyLimited).toBe(1);
  });

  test("forwards core calls with the broker's viewer and ignores a plugin-supplied one", async () => {
    const calls: CoreCall[] = [];
    const core: CoreForwarder = {
      async call(call) {
        calls.push(call);
        return { id: "42", title: "Hello" };
      },
    };
    const { broker } = createBroker({ core });

    const result = await broker.handle({
      method: "core.call",
      pluginId: "sandbox-demo",
      viewer: { memberId: "7" },
      params: {
        method: "posts.get",
        params: { id: "42" },
        viewer: { memberId: "admin" },
      },
    });

    expect(result).toEqual({ id: "42", title: "Hello" });
    expect(calls).toEqual([
      {
        pluginId: "sandbox-demo",
        method: "posts.get",
        params: { id: "42" },
        viewer: { memberId: "7" },
      },
    ]);
  });

  test("treats core calls without a viewer as guest", async () => {
    const calls: CoreCall[] = [];
    const { broker } = createBroker({
      core: {
        async call(call) {
          calls.push(call);
          return null;
        },
      },
    });

    await broker.handle({
      method: "core.call",
      pluginId: "sandbox-demo",
      params: { method: "posts.get", params: {} },
    });

    expect(calls[0]?.viewer).toEqual({ memberId: null });
  });

  test("maps core denials to a policy error and reports missing configuration", async () => {
    const { broker } = createBroker({
      core: {
        async call() {
          throw new CoreDeniedError("response", "Core API denied the request for this viewer");
        },
      },
    });

    try {
      await broker.handle({
        method: "core.call",
        pluginId: "sandbox-demo",
        params: { method: "posts.get", params: {} },
      });
      throw new Error("Expected a core denial");
    } catch (error) {
      expect((error as RpcError).code).toBe(-32000);
      expect((error as RpcError).data).toMatchObject({ reason: "response" });
    }

    const unconfigured = createBroker().broker;
    await expectRpcError(
      unconfigured.handle({
        method: "core.call",
        pluginId: "sandbox-demo",
        params: { method: "posts.get" },
      }),
      -32601,
    );
  });

  test("invalidates cache tags in the plugin namespace only", async () => {
    const bumps: string[][] = [];
    const cache = new CacheInvalidator({
      bump: async (tags) => {
        bumps.push([...tags]);
      },
      logger: cacheLogger,
      coalesceMs: 1,
    });
    const { broker } = createBroker({ cache });

    await expect(
      broker.handle({
        method: "cache.invalidate",
        pluginId: "sandbox-demo",
        params: { tags: ["leaderboard", "forum:3"] },
      }),
    ).resolves.toEqual({
      tags: ["plugin:sandbox-demo:leaderboard", "plugin:sandbox-demo:forum:3"],
    });
    expect(bumps).toEqual([["plugin:sandbox-demo:leaderboard", "plugin:sandbox-demo:forum:3"]]);
    expect(bumps[0]).not.toContain("forum:3");
    expect(broker.stats().invalidations).toBe(1);
  });

  test("rejects invalid cache.invalidate params", async () => {
    const cache = new CacheInvalidator({ bump: async () => undefined, logger: cacheLogger });
    const { broker } = createBroker({ cache });

    await expectRpcError(
      broker.handle({
        method: "cache.invalidate",
        pluginId: "sandbox-demo",
        params: { tags: "not-an-array" },
      }),
      -32602,
    );
  });

  test("denies every broker method without the approved capability", async () => {
    const grants =
      (capabilities: readonly string[]): PluginGrantsLoader =>
      async () => ({
        capabilities,
        egressHosts: ALL_GRANTS.egressHosts,
      });
    const coreCalls: CoreCall[] = [];
    const core: CoreForwarder = {
      async call(call) {
        coreCalls.push(call);
        return null;
      },
    };
    const cache = new CacheInvalidator({ bump: async () => undefined, logger: cacheLogger });

    for (const [method, params] of [
      ["db.query", { sql: "SELECT 1" }],
      ["http.fetch", { url: "https://example.com/data" }],
      ["cache.invalidate", { tags: ["tips"] }],
      ["core.call", { method: "posts.get", params: {} }],
    ] as const) {
      const { broker, database, egress } = createBroker({
        grants: grants([]),
        core,
        cache,
      });

      await expect(
        broker.handle({ method, pluginId: "sandbox-demo", params }),
      ).rejects.toMatchObject({ code: -32000, data: { reason: "capability" } });
      expect(database.queries).toEqual([]);
      expect(egress.requests).toEqual([]);
    }

    expect(coreCalls).toEqual([]);
  });

  test("denies a capability the manifest declared but the admin did not approve", async () => {
    const { broker, egress } = createBroker({
      grants: async () => ({ capabilities: ["db"], egressHosts: ["example.com"] }),
    });

    // The bundle declares egress and example.com, but only the approved grants count.
    await expect(
      broker.handle({
        method: "http.fetch",
        pluginId: "sandbox-demo",
        params: { url: "https://example.com/data" },
      }),
    ).rejects.toMatchObject({ code: -32000, data: { reason: "capability" } });
    expect(egress.requests).toEqual([]);
  });

  test("denies an egress host outside the approved allowlist", async () => {
    const { broker, egress } = createBroker({
      grants: async () => ({ capabilities: ["egress"], egressHosts: ["api.example.com"] }),
    });

    await expect(
      broker.handle({
        method: "http.fetch",
        pluginId: "sandbox-demo",
        params: { url: "https://evil.example.com/data" },
      }),
    ).rejects.toMatchObject({ code: -32000, data: { reason: "host" } });
    expect(egress.requests).toEqual([]);
  });

  test("denies core methods outside the approved core scope", async () => {
    const calls: CoreCall[] = [];
    const { broker } = createBroker({
      grants: async () => ({ capabilities: ["core.read"], egressHosts: [] }),
      core: {
        async call(call) {
          calls.push(call);
          return null;
        },
      },
    });

    await expect(
      broker.handle({
        method: "core.call",
        pluginId: "sandbox-demo",
        params: { method: "members.addBadge", params: {} },
      }),
    ).rejects.toMatchObject({ code: -32000, data: { reason: "capability" } });
    expect(calls).toEqual([]);
  });

  test("fails closed when the approved grants cannot be loaded", async () => {
    const { broker } = createBroker({
      grants: async () => {
        throw new Error("database unavailable");
      },
    });

    await expect(
      broker.handle({
        method: "db.query",
        pluginId: "sandbox-demo",
        params: { sql: "SELECT 1" },
      }),
    ).rejects.toMatchObject({ code: -32000, data: { reason: "grants" } });
  });

  test("rejects every request from a disabled plugin", async () => {
    const { broker } = createBroker({ isActive: async () => false });

    await expect(
      broker.handle({ method: "db.query", pluginId: "sandbox-demo", params: { sql: "SELECT 1" } }),
    ).rejects.toMatchObject({ code: -32000 });
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
