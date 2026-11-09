import { describe, expect, test } from "bun:test";
import { orderSeedModules, SeedError, type SeedModule } from "./framework.ts";
import { createSeededRng } from "./rng.ts";

function module(name: string, dependsOn?: readonly string[]): SeedModule {
  return {
    name,
    ...(dependsOn === undefined ? {} : { dependsOn }),
    async run() {},
  };
}

describe("seed ordering", () => {
  test("orders dependencies before dependants", () => {
    const ordered = orderSeedModules([
      module("posts", ["forums"]),
      module("forums", ["members"]),
      module("members"),
    ]);

    expect(ordered.map((entry) => entry.name)).toEqual(["members", "forums", "posts"]);
  });

  test("rejects missing dependencies", () => {
    expect(() => orderSeedModules([module("posts", ["forums"])])).toThrow(SeedError);
  });

  test("rejects cycles and duplicate names", () => {
    expect(() => orderSeedModules([module("a", ["b"]), module("b", ["a"])])).toThrow(SeedError);
    expect(() => orderSeedModules([module("a"), module("a")])).toThrow(SeedError);
  });
});

describe("seeded RNG", () => {
  test("is reproducible for the same seed", () => {
    const first = createSeededRng(42);
    const second = createSeededRng(42);

    expect(Array.from({ length: 20 }, () => first())).toEqual(
      Array.from({ length: 20 }, () => second()),
    );
  });

  test("differs for a different seed", () => {
    expect(createSeededRng(42)()).not.toBe(createSeededRng(43)());
  });
});
