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
    let versionReads = 0;
    let dataLoads = 0;
    let groupLoads = 0;

    const cache = createPermissionSnapshotCache({
      readVersion: async () => {
        versionReads += 1;
        return version;
      },
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

    await cache.data(loadData);
    await cache.group("1", loadGroup);
    expect({ dataLoads, groupLoads, versionReads }).toEqual({
      dataLoads: 1,
      groupLoads: 1,
      versionReads: 1,
    });

    clock = 500;
    await cache.data(loadData);
    await cache.group("1", loadGroup);
    expect({ dataLoads, groupLoads, versionReads }).toEqual({
      dataLoads: 1,
      groupLoads: 1,
      versionReads: 1,
    });

    version = "1";
    clock = 999;
    await cache.data(loadData);
    expect({ dataLoads, versionReads }).toEqual({ dataLoads: 1, versionReads: 1 });

    clock = 1_000;
    expect(await cache.data(loadData)).toEqual(data());
    expect(await cache.group("1", loadGroup)).toEqual(group());
    expect({ dataLoads, groupLoads, versionReads }).toEqual({
      dataLoads: 2,
      groupLoads: 2,
      versionReads: 2,
    });

    version = "2";
    cache.invalidate();
    await cache.data(loadData);
    await cache.group("1", loadGroup);
    expect({ dataLoads, groupLoads, versionReads }).toEqual({
      dataLoads: 3,
      groupLoads: 3,
      versionReads: 3,
    });
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

    await cache.group("2,3", load);
    await cache.group("2,3", load);
    await cache.group("3,4", load);

    expect(loads).toBe(2);
  });
});
