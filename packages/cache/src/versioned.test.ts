import { describe, expect, test } from "bun:test";
import { createVersionedCache, type VersionedValueSource } from "./versioned.ts";

class FakeSource implements VersionedValueSource<string, string> {
  readonly values = new Map<string, string>([["locale", "shipped"]]);
  versionNumber = 0;
  loads = 0;

  async version(): Promise<string> {
    return String(this.versionNumber);
  }

  async load(key: string): Promise<string> {
    this.loads += 1;
    return this.values.get(key) ?? "";
  }
}

describe("versioned cache", () => {
  test("reads a value once while its tag version is unchanged", async () => {
    const source = new FakeSource();
    const cache = createVersionedCache(source);

    expect((await cache.get("locale")).value).toBe("shipped");
    expect((await cache.get("locale")).value).toBe("shipped");
    expect(source.loads).toBe(1);
  });

  test("reloads after the tag version changes", async () => {
    const source = new FakeSource();
    const cache = createVersionedCache(source);

    await cache.get("locale");
    source.values.set("locale", "override");
    source.versionNumber = 1;

    expect((await cache.get("locale")).value).toBe("override");
    expect(source.loads).toBe(2);
  });

  test("retries when the tag changes during a load", async () => {
    const source = new FakeSource();
    const originalLoad = source.load.bind(source);
    let changed = false;

    source.load = async (key) => {
      const value = await originalLoad(key);
      if (!changed) {
        changed = true;
        source.versionNumber = 1;
      }
      return value;
    };

    const cache = createVersionedCache(source);
    const entry = await cache.get("locale");

    expect(entry.version).toBe("1");
    expect(source.loads).toBe(2);
  });

  test("can invalidate one entry or the whole cache", async () => {
    const source = new FakeSource();
    const cache = createVersionedCache(source);

    await cache.get("locale");
    cache.invalidate("locale");
    await cache.get("locale");
    expect(source.loads).toBe(2);

    cache.invalidate();
    await cache.get("locale");
    expect(source.loads).toBe(3);
  });
});
