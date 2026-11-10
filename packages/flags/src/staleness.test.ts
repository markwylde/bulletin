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

function flag(
  rules: readonly FlagRule[] = [],
  defaultValue = true,
  affectsRender = false,
): FlagDefinition {
  return {
    ...defineFlag({
      key: "sampleFeature",
      description: "Sample flag.",
      owner: "core",
      default: defaultValue,
      affectsRender,
    }),
    rules,
  };
}

function daysAgo(days: number): Date {
  return new Date(NOW - days * DAY_MS);
}

describe("flag staleness", () => {
  test("treats a flag as fully on only when every viewer evaluates true", () => {
    expect(isFullyOn(flag())).toBe(true);
    expect(isFullyOn(flag([], false))).toBe(false);
    expect(isFullyOn(flag([{ type: "group", groups: ["members"], value: true }]))).toBe(true);
    expect(isFullyOn(flag([{ type: "group", groups: ["banned"], value: false }]))).toBe(false);
    expect(isFullyOn(flag([{ type: "percentage", percent: 100, value: true }]))).toBe(true);
    expect(isFullyOn(flag([{ type: "percentage", percent: 100, value: false }]))).toBe(false);
    // A default-on flag stays on for the buckets a partial enable rule does not match.
    expect(isFullyOn(flag([{ type: "percentage", percent: 50, value: true }]))).toBe(true);
    // Enabling a group on a default-off flag still leaves everyone else off.
    expect(isFullyOn(flag([{ type: "group", groups: ["members"], value: true }], false))).toBe(
      false,
    );
  });

  test("ignores disable rules that evaluation can never reach", () => {
    expect(
      isFullyOn(
        flag([
          { type: "percentage", percent: 100, value: true },
          { type: "percentage", percent: 50, value: false },
        ]),
      ),
    ).toBe(true);

    // Every member hits the 100% rule first; guests never match a `members` rule.
    expect(
      isFullyOn(
        flag([
          { type: "percentage", percent: 100, value: true },
          { type: "group", groups: ["members"], value: false },
        ]),
      ),
    ).toBe(true);

    // The same disable rule is reachable for guests, so the flag is no longer fully on.
    expect(
      isFullyOn(
        flag([
          { type: "percentage", percent: 100, value: true },
          { type: "group", groups: ["guests"], value: false },
        ]),
      ),
    ).toBe(false);

    // An earlier rule for the same group already decides the outcome.
    expect(
      isFullyOn(
        flag([
          { type: "group", groups: ["members"], value: true },
          { type: "group", groups: ["members"], value: false },
        ]),
      ),
    ).toBe(true);
  });

  test("accounts for guests on render-affecting flags", () => {
    const renderRules: readonly FlagRule[] = [{ type: "percentage", percent: 100, value: true }];

    // Guests never receive a percentage rule, so a render flag stays off for them.
    expect(isFullyOn(flag(renderRules, false, true))).toBe(false);
    expect(
      isFullyOn(
        flag([...renderRules, { type: "group", groups: ["guests"], value: true }], false, true),
      ),
    ).toBe(true);
    expect(
      isFullyOn(
        flag([...renderRules, { type: "group", groups: ["guests"], value: true }], false, false),
      ),
    ).toBe(true);
  });

  test("highlights a fully-on flag untouched for ninety days", () => {
    expect(STALE_FLAG_DAYS).toBe(90);
    expect(isStaleFlag(flag(), daysAgo(90), NOW)).toBe(true);
    expect(isStaleFlag(flag(), daysAgo(120), NOW)).toBe(true);
    expect(isStaleFlag(flag(), new Date(NOW - STALE_FLAG_MS + 1), NOW)).toBe(false);

    // A partial enable rule on a default-on flag is still fully on, so it goes stale too.
    expect(
      isStaleFlag(flag([{ type: "percentage", percent: 50, value: true }]), daysAgo(120), NOW),
    ).toBe(true);
    expect(
      isStaleFlag(
        flag([
          { type: "percentage", percent: 100, value: true },
          { type: "percentage", percent: 50, value: false },
        ]),
        daysAgo(120),
        NOW,
      ),
    ).toBe(true);

    expect(isStaleFlag(flag([], false), daysAgo(120), NOW)).toBe(false);
    expect(
      isStaleFlag(
        flag([{ type: "percentage", percent: 50, value: true }], false),
        daysAgo(120),
        NOW,
      ),
    ).toBe(false);
  });

  test("reports the age of the flag in whole days", () => {
    expect(flagAgeDays(daysAgo(0), NOW)).toBe(0);
    expect(flagAgeDays(new Date(NOW - DAY_MS - 1), NOW)).toBe(1);
    expect(flagAgeDays(daysAgo(120), NOW)).toBe(120);
    expect(flagAgeDays(new Date(NOW + DAY_MS), NOW)).toBe(0);
  });
});
