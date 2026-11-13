import { describe, expect, test } from "bun:test";
import {
  formatVersion,
  parseVersion,
  SDK_VERSION,
  satisfiesSdkRange,
  sdkCompatibility,
  shimHookName,
} from "./semver.ts";

describe("SDK semver", () => {
  test("parses versions and rejects malformed ones", () => {
    expect(parseVersion("2.1.3")).toEqual({ major: 2, minor: 1, patch: 3 });
    expect(parseVersion("1.0.0-beta.1")).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseVersion("2.1")).toBeUndefined();
    expect(formatVersion({ major: 2, minor: 1, patch: 3 })).toBe("2.1.3");
  });

  test.each([
    ["^2.0.0", "2.0.0", true],
    ["^2.0.0", "2.9.9", true],
    ["^2.0.0", "3.0.0", false],
    ["~1.2.0", "1.2.9", true],
    ["~1.2.0", "1.3.0", false],
    [">=1.5.0", "2.0.0", true],
    ["<2.0.0", "1.9.9", true],
    [">=1.0.0 <2.0.0", "2.0.0", false],
    ["1.x", "1.7.2", true],
    ["1.2.x", "1.3.0", false],
    ["*", "9.0.0", true],
    ["^1.0.0 || ^2.0.0", "2.1.0", true],
  ])("checks %s against %s", (range, version, expected) => {
    expect(satisfiesSdkRange(range, version)).toBe(expected);
  });

  test("accepts the previous major through a shim and flags it deprecated", () => {
    expect(sdkCompatibility("^1.0.0")).toEqual({
      compatible: true,
      deprecated: true,
      shimMajor: 1,
    });
    expect(sdkCompatibility("^2.0.0")).toEqual({
      compatible: true,
      deprecated: false,
      shimMajor: null,
    });
    expect(sdkCompatibility("^0.9.0")).toEqual({
      compatible: false,
      deprecated: false,
      shimMajor: null,
    });
    expect(SDK_VERSION.startsWith("2.")).toBe(true);
  });

  test("maps retired v1 hook names only for the shim major", () => {
    expect(shimHookName("post.enrich", 1)).toBe("post.view.enrich");
    expect(shimHookName("post.enrich", 2)).toBe("post.enrich");
    expect(shimHookName("post.view.enrich", 1)).toBe("post.view.enrich");
  });
});
