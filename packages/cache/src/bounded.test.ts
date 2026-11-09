import { describe, expect, test } from "bun:test";
import { createBoundedCache } from "./bounded.ts";

describe("bounded cache", () => {
  test("evicts the least-recently-used entries to stay under the byte limit", () => {
    const cache = createBoundedCache<string, string>({ maxBytes: 10 });

    cache.set("a", "A", 4);
    cache.set("b", "B", 4);
    cache.get("a");
    cache.set("c", "C", 4);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.get("c")).toBe("C");
    expect(cache.bytes).toBeLessThanOrEqual(10);
  });

  test("replacing a key updates its size and recency", () => {
    const cache = createBoundedCache<string, string>({ maxBytes: 12 });

    cache.set("a", "old", 8);
    cache.set("a", "new", 3);
    cache.set("b", "B", 3);

    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(6);
    expect(cache.get("a")).toBe("new");
  });

  test("does not retain an entry larger than the cache", () => {
    const cache = createBoundedCache<string, string>({ maxBytes: 4 });

    cache.set("large", "value", 5);

    expect(cache.get("large")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("clear resets entries and bytes", () => {
    const cache = createBoundedCache<string, string>({ maxBytes: 10 });
    cache.set("a", "A", 3);
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });
});
