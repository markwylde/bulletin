import { describe, expect, test } from "bun:test";
import type { CompiledGroupSnapshot, PermissionData } from "./snapshot.ts";
import { createPermissionSnapshotCache } from "./snapshot-cache.ts";
import { createForumTree } from "./tree.ts";

const TREE = createForumTree([{ id: "1", parentId: null, passwordProtected: false }]);

function data(): PermissionData {
  return {
    tree: TREE,
    masksByGroup: new Map(),
    matrix: [],
    globalPowersByGroup: new Map(),
  };
}

function group(): CompiledGroupSnapshot {
  return { bits: new Map([["1", 1]]), globalPowers: new Set() };
}

describe("permission snapshot cache", () => {
  test("reuses entries until the perm version changes at the one-second backstop", async () => {
    let clock = 0;
    let version = "0";
    let dataLoads = 0;
    let groupLoads = 0;

    const cache = createPermissionSnapshotCache({
      readVersion: async () => version,
      now: () => clock,
      backstopMs: 1_000,
    });

    const loadData = async (): Promise<PermissionData> => {
      dataLoads += 1;
      return data();
    };
    const loadGroup = async (): Promise<CompiledGroupSnapshot> => {
      groupLoads += 1;
      return group();
    };

    const first = await cache.data(loadData);
    await cache.group("1", first.version, loadGroup);
    expect({ dataLoads, groupLoads }).toEqual({ dataLoads: 1, groupLoads: 1 });

    clock = 500;
    const same = await cache.data(loadData);
    await cache.group("1", same.version, loadGroup);
    expect({ dataLoads, groupLoads }).toEqual({ dataLoads: 1, groupLoads: 1 });

    version = "1";
    clock = 999;
    expect((await cache.data(loadData)).version).toBe("0");

    clock = 1_000;
    const refreshed = await cache.data(loadData);
    expect(refreshed.version).toBe("1");
    expect((await cache.group("1", refreshed.version, loadGroup))?.value).toEqual(group());
    expect({ dataLoads, groupLoads }).toEqual({ dataLoads: 2, groupLoads: 2 });

    version = "2";
    cache.invalidate();
    const invalidated = await cache.data(loadData);
    expect(invalidated.version).toBe("2");
    await cache.group("1", invalidated.version, loadGroup);
    expect({ dataLoads, groupLoads }).toEqual({ dataLoads: 3, groupLoads: 3 });
  });

  test("refuses to compile data from a stale perm version", async () => {
    let clock = 0;
    let version = "0";
    let groupLoads = 0;
    const cache = createPermissionSnapshotCache({
      readVersion: async () => version,
      now: () => clock,
      backstopMs: 1_000,
    });
    const loadGroup = async (): Promise<CompiledGroupSnapshot> => {
      groupLoads += 1;
      return group();
    };

    const stale = await cache.data(async () => data());
    expect(stale.version).toBe("0");

    version = "1";
    clock = 1_000;
    expect(await cache.group("group", stale.version, loadGroup)).toBeNull();
    expect(groupLoads).toBe(0);

    const fresh = await cache.data(async () => data());
    expect(fresh.version).toBe("1");
    expect((await cache.group("group", fresh.version, loadGroup))?.value).toEqual(group());
    expect(groupLoads).toBe(1);
  });

  test("shares group snapshots by key", async () => {
    let loads = 0;
    const cache = createPermissionSnapshotCache({
      readVersion: async () => "0",
      now: () => 0,
    });
    const load = async (): Promise<CompiledGroupSnapshot> => {
      loads += 1;
      return group();
    };
    const entry = await cache.data(async () => data());

    await cache.group("2,3", entry.version, load);
    await cache.group("2,3", entry.version, load);
    await cache.group("3,4", entry.version, load);

    expect(loads).toBe(2);
  });
});
