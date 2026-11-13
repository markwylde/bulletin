import { describe, expect, test } from "bun:test";
import { checkAppliedLimits, describeLimitMismatches } from "./limits.ts";
import { DEFAULT_SANDBOX_LIMITS, type SandboxCgroupUsage } from "./types.ts";

function usage(overrides: Partial<SandboxCgroupUsage> = {}): SandboxCgroupUsage {
  return {
    memoryCurrentBytes: 3 * 1024 * 1024,
    memoryMaxBytes: DEFAULT_SANDBOX_LIMITS.memoryBytes,
    anonBytes: 2 * 1024 * 1024,
    fileBytes: 1024 * 1024,
    pidsMax: DEFAULT_SANDBOX_LIMITS.pids,
    cpuMax: `${DEFAULT_SANDBOX_LIMITS.cpuMsPerSecond * 1_000} 1000000`,
    ...overrides,
  };
}

describe("applied sandbox limits", () => {
  test("accepts a cgroup that matches every requested limit", () => {
    expect(checkAppliedLimits(usage(), DEFAULT_SANDBOX_LIMITS)).toEqual([]);
  });

  test("accepts a full core expressed as max", () => {
    const limits = { ...DEFAULT_SANDBOX_LIMITS, cpuMsPerSecond: 1_000 };

    expect(checkAppliedLimits(usage({ cpuMax: "max 1000000" }), limits)).toEqual([]);
  });

  test.each([
    ["memory", { memoryMaxBytes: 1024 * 1024 * 1024 }],
    ["pids", { pidsMax: 512 }],
    ["cpu", { cpuMax: "10000 100000" }],
  ] as const)("rejects a %s limit that did not stick", (limit, overrides) => {
    const mismatches = checkAppliedLimits(usage(overrides), DEFAULT_SANDBOX_LIMITS);

    expect(mismatches.map((mismatch) => mismatch.limit)).toEqual([limit]);
    expect(describeLimitMismatches(mismatches)).toContain(`${limit} limit is`);
  });

  test("treats a missing cgroup value as a mismatch, not as the default", () => {
    const mismatches = checkAppliedLimits(
      usage({ memoryMaxBytes: null, pidsMax: null, cpuMax: null }),
      DEFAULT_SANDBOX_LIMITS,
    );

    expect(mismatches.map((mismatch) => mismatch.limit)).toEqual(["memory", "pids", "cpu"]);
  });

  test("checks the CPU period as well as the quota", () => {
    const mismatches = checkAppliedLimits(
      usage({ cpuMax: `${DEFAULT_SANDBOX_LIMITS.cpuMsPerSecond * 1_000} 50000` }),
      DEFAULT_SANDBOX_LIMITS,
    );

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.actual).toBe(`${DEFAULT_SANDBOX_LIMITS.cpuMsPerSecond * 1_000} 50000`);
  });
});
