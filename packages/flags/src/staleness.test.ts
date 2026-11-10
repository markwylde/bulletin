import { describe, expect, test } from "bun:test";
import { defineFlag } from "./defaults.ts";
import {
  DAY_MS,
  flagAgeDays,
  isFullyOn,
  isStaleFlag,
  STALE_FLAG_DAYS,
  STALE_FLAG_MS,
} from "./staleness.ts";
import type { FlagDefinition, FlagRule } from "./types.ts";

const NOW = Date.UTC(2026, 0, 1);

function flag(rules: readonly FlagRule[] = [], defaultValue = true): FlagDefinition {
  return {
    ...defineFlag({
      key: "sampleFeature",
      description: "Sample flag.",
      owner: "core",
      default: defaultValue,
    }),
    rules,
  };
}

function daysAgo(days: number): Date {
  return new Date(NOW - days * DAY_MS);
}

describe("flag staleness", () => {
  test("treats a flag as fully on only when no viewer can get false", () => {
    expect(isFullyOn(flag())).toBe(true);
    expect(isFullyOn(flag([], false))).toBe(false);
    expect(isFullyOn(flag([{ type: "group", groups: ["members"], value: true }]))).toBe(true);
    expect(isFullyOn(flag([{ type: "group", groups: ["banned"], value: false }]))).toBe(false);
    expect(isFullyOn(flag([{ type: "percentage", percent: 100, value: true }]))).toBe(true);
    expect(isFullyOn(flag([{ type: "percentage", percent: 50, value: true }]))).toBe(false);
    expect(isFullyOn(flag([{ type: "percentage", percent: 100, value: false }]))).toBe(false);
  });

  test("highlights a fully-on flag untouched for ninety days", () => {
    expect(STALE_FLAG_DAYS).toBe(90);
    expect(isStaleFlag(flag(), daysAgo(90), NOW)).toBe(true);
    expect(isStaleFlag(flag(), daysAgo(120), NOW)).toBe(true);
    expect(isStaleFlag(flag(), new Date(NOW - STALE_FLAG_MS + 1), NOW)).toBe(false);
    expect(isStaleFlag(flag([], false), daysAgo(120), NOW)).toBe(false);
    expect(
      isStaleFlag(flag([{ type: "percentage", percent: 50, value: true }]), daysAgo(120), NOW),
    ).toBe(false);
  });

  test("reports the age of the flag in whole days", () => {
    expect(flagAgeDays(daysAgo(0), NOW)).toBe(0);
    expect(flagAgeDays(new Date(NOW - DAY_MS - 1), NOW)).toBe(1);
    expect(flagAgeDays(daysAgo(120), NOW)).toBe(120);
    expect(flagAgeDays(new Date(NOW + DAY_MS), NOW)).toBe(0);
  });
});
