import type { SandboxCgroupUsage, SandboxLimits } from "./types.ts";

/**
 * Post-spawn verification that nsjail actually applied the cgroup limits.
 *
 * Engines differ in which controllers they delegate (rootless Podman mounts the cgroup
 * hierarchy read-only and only delegates an ancestor), and a limit that silently failed to
 * write would leave a plugin unbounded. The supervisor therefore refuses to call a sandbox
 * ready unless the values it reads back match the request.
 */

// nsjail writes the per-second quota over a one-second period (`cpu.max`).
const CPU_PERIOD_US = 1_000_000;

export interface LimitMismatch {
  readonly limit: "cpu" | "memory" | "pids";
  readonly expected: string;
  readonly actual: string;
}

function memoryMismatch(
  usage: SandboxCgroupUsage,
  limits: SandboxLimits,
): LimitMismatch | undefined {
  return usage.memoryMaxBytes === limits.memoryBytes
    ? undefined
    : {
        limit: "memory",
        expected: String(limits.memoryBytes),
        actual: String(usage.memoryMaxBytes),
      };
}

function pidsMismatch(usage: SandboxCgroupUsage, limits: SandboxLimits): LimitMismatch | undefined {
  return usage.pidsMax === limits.pids
    ? undefined
    : { limit: "pids", expected: String(limits.pids), actual: String(usage.pidsMax) };
}

function cpuMismatch(usage: SandboxCgroupUsage, limits: SandboxLimits): LimitMismatch | undefined {
  const expectedQuota = limits.cpuMsPerSecond * 1_000;
  const [quota, period] = (usage.cpuMax ?? "").trim().split(/\s+/);
  const expected = `${String(expectedQuota)} ${String(CPU_PERIOD_US)}`;
  const applied = `${quota ?? "missing"} ${period ?? "missing"}`;
  // A full core is expressed as `max 1000000`; both spellings mean the same limit.
  const fullCore = expectedQuota === CPU_PERIOD_US && quota === "max";
  const matches = (quota === String(expectedQuota) || fullCore) && period === String(CPU_PERIOD_US);

  return matches ? undefined : { limit: "cpu", expected, actual: applied };
}

/** Returns every limit that nsjail did not apply as requested. */
export function checkAppliedLimits(
  usage: SandboxCgroupUsage,
  limits: SandboxLimits,
): LimitMismatch[] {
  return [
    memoryMismatch(usage, limits),
    pidsMismatch(usage, limits),
    cpuMismatch(usage, limits),
  ].filter((mismatch): mismatch is LimitMismatch => mismatch !== undefined);
}

/** Human-readable one-line reason used in sandbox errors and logs. */
export function describeLimitMismatches(mismatches: readonly LimitMismatch[]): string {
  return mismatches
    .map(
      (mismatch) => `${mismatch.limit} limit is ${mismatch.actual}, expected ${mismatch.expected}`,
    )
    .join("; ");
}
