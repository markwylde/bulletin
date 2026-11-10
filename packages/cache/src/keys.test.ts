import { describe, expect, test } from "bun:test";
import { type CacheVariantInput, stableKey, variantKey } from "./keys.ts";

const base: CacheVariantInput = {
  route: "/_demo/[id]",
  params: { id: "2" },
  visibilityKey: "vis-1",
  themeId: 1,
  themeVersion: 3,
  pluginsGeneration: 1,
  locale: "en",
  colourScheme: "system",
  renderFlagsHash: "flags-1",
};

describe("stableKey", () => {
  test("is order independent and keeps undefined apart from empty", () => {
    expect(stableKey({ a: 1, b: 2 })).toBe(stableKey({ b: 2, a: 1 }));
    expect(stableKey({ a: undefined })).not.toBe(stableKey({ a: "" }));
  });
});

describe("variantKey", () => {
  test("is deterministic", () => {
    expect(variantKey(base)).toBe(variantKey({ ...base, params: { id: "2" } }));
  });

  test("separates every ADR 0006 dimension", () => {
    const keys = new Set([
      variantKey(base),
      variantKey({ ...base, route: "/_demo/other" }),
      variantKey({ ...base, params: { id: "3" } }),
      variantKey({ ...base, visibilityKey: "vis-2" }),
      variantKey({ ...base, themeId: 2 }),
      variantKey({ ...base, themeVersion: 4 }),
      variantKey({ ...base, pluginsGeneration: 2 }),
      variantKey({ ...base, locale: "fr" }),
      variantKey({ ...base, colourScheme: "dark" }),
      variantKey({ ...base, renderFlagsHash: "flags-2" }),
    ]);

    expect(keys.size).toBe(10);
  });

  test("changes with the resolved theme content fingerprint", () => {
    expect(variantKey({ ...base, themeContentKey: "1@1+1/page@1" })).not.toBe(
      variantKey({ ...base, themeContentKey: "1@1+1/page@2" }),
    );
  });

  test("never includes a member or session id", () => {
    const key = variantKey(base);

    expect(key).not.toContain("member");
    expect(key).not.toContain("session");
  });

  test("rejects an empty route or visibility key", () => {
    expect(() => variantKey({ ...base, route: " " })).toThrow("route");
    expect(() => variantKey({ ...base, visibilityKey: "" })).toThrow("visibilityKey");
  });
});
