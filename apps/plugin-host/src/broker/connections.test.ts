import { describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import {
  ConnectionBudgetError,
  DEFAULT_OPEN_PLUGIN_BUDGET,
  PluginConnectionManager,
} from "./connections.ts";

interface FakePool {
  readonly sql: SQL;
  closed: boolean;
}

function createFactory(): { factory: (pluginId: string) => SQL; pools: Map<string, FakePool> } {
  const pools = new Map<string, FakePool>();

  return {
    pools,
    factory(pluginId) {
      const pool: FakePool = { closed: false, sql: undefined as unknown as SQL };
      const callable = (async () => [{ ok: 1 }]) as unknown as SQL & {
        close: () => Promise<void>;
      };
      callable.close = async () => {
        pool.closed = true;
      };
      (pool as { sql: SQL }).sql = callable;
      pools.set(pluginId, pool);
      return callable;
    },
  };
}

function manager(
  options: { maxOpenPlugins?: number; idleTimeoutMs?: number; waitTimeoutMs?: number } = {},
): { manager: PluginConnectionManager; pools: Map<string, FakePool> } {
  const { factory, pools } = createFactory();

  return {
    pools,
    manager: new PluginConnectionManager({
      adminUrl: "postgres://bulletin@postgres/bulletin",
      createPool: factory,
      idleTimeoutMs: 5_000,
      ...options,
    }),
  };
}

describe("plugin connection budget", () => {
  test("starts 15 plugins lazily under the default budget", async () => {
    const { manager: connections, pools } = manager();
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, index) =>
        connections.withConnection(`plugin-${String(index)}`, async () => "ok"),
      ),
    );

    expect(results).toHaveLength(15);
    expect(new Set(results)).toEqual(new Set(["ok"]));
    expect(connections.stats()).toMatchObject({
      open: 15,
      maxOpen: DEFAULT_OPEN_PLUGIN_BUDGET,
      opened: 15,
      closed: 0,
      rejections: 0,
    });
    expect(pools.size).toBe(15);

    await connections.close();
    expect([...pools.values()].every((pool) => pool.closed)).toBe(true);
  });

  test("closes a pool after the idle timeout and reopens it on demand", async () => {
    const { manager: connections, pools } = manager({ idleTimeoutMs: 20 });

    await connections.withConnection("plugin-a", async () => "first");
    expect(connections.stats().open).toBe(1);

    await Bun.sleep(50);
    expect(connections.stats()).toMatchObject({ open: 0, opened: 1, closed: 1 });
    expect(pools.get("plugin-a")?.closed).toBe(true);

    await connections.withConnection("plugin-a", async () => "second");
    expect(connections.stats()).toMatchObject({ open: 1, opened: 2 });
    await connections.close();
  });

  test("fails only the plugin waiting when the budget is exhausted", async () => {
    const { manager: connections } = manager({ maxOpenPlugins: 2, waitTimeoutMs: 20 });

    await connections.withConnection("plugin-a", async () => undefined);
    await connections.withConnection("plugin-b", async () => undefined);

    await expect(
      connections.withConnection("plugin-c", async () => undefined),
    ).rejects.toBeInstanceOf(ConnectionBudgetError);

    // The two open plugins keep working; only the waiter failed.
    await expect(connections.withConnection("plugin-a", async () => "still")).resolves.toBe(
      "still",
    );
    expect(connections.stats()).toMatchObject({ open: 2, rejections: 1 });

    await connections.close();
  });

  test("hands a freed idle slot to the waiting plugin", async () => {
    const { manager: connections } = manager({
      maxOpenPlugins: 2,
      idleTimeoutMs: 20,
      waitTimeoutMs: 5_000,
    });

    await connections.withConnection("plugin-a", async () => undefined);
    await connections.withConnection("plugin-b", async () => undefined);
    const waiting = connections.withConnection("plugin-c", async () => "served");

    await expect(waiting).resolves.toBe("served");
    expect(connections.stats().open).toBeGreaterThanOrEqual(1);
    expect(connections.stats().open).toBeLessThanOrEqual(2);
    await connections.close();
  });

  test("releases the slot when a pool fails to open", async () => {
    const connections = new PluginConnectionManager({
      adminUrl: "postgres://bulletin@postgres/bulletin",
      maxOpenPlugins: 1,
      createPool: () => {
        throw new Error("cannot connect");
      },
    });

    await expect(connections.withConnection("plugin-a", async () => undefined)).rejects.toThrow(
      "cannot connect",
    );
    expect(connections.stats()).toMatchObject({ open: 0, closed: 0 });
  });
});
