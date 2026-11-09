/** Resource limits enforced around one plugin sandbox (ADR 0009). */
export interface SandboxLimits {
  /** cgroup v2 `memory.max`, in bytes. */
  readonly memoryBytes: number;
  /** cgroup v2 CPU quota expressed as milliseconds of CPU per second. */
  readonly cpuMsPerSecond: number;
  /** cgroup v2 `pids.max`. */
  readonly pids: number;
  /** `RLIMIT_NPROC`, a second line of defence for fork bombs. */
  readonly nproc: number;
  /** `RLIMIT_NOFILE`. */
  readonly nofile: number;
  /** `RLIMIT_FSIZE`, in megabytes. */
  readonly fileSizeMb: number;
  /** nsjail's wall-clock watchdog and `RLIMIT_CPU`, in seconds. */
  readonly wallClockSeconds: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 256 * 1024 * 1024,
  cpuMsPerSecond: 500,
  pids: 64,
  nproc: 64,
  nofile: 256,
  fileSizeMb: 16,
  wallClockSeconds: 3600,
};

export type SandboxState = "idle" | "starting" | "ready" | "stopping" | "stopped" | "failed";

/** cgroup v2 values read from the sandbox's own cgroup while it runs. */
export interface SandboxCgroupUsage {
  readonly memoryCurrentBytes: number | null;
  readonly memoryMaxBytes: number | null;
  /** Anonymous (unshared) memory; the part cgroup memory limits bound per sandbox. */
  readonly anonBytes: number | null;
  /** Page cache charged to this cgroup; the Bun binary is shared after the first sandbox. */
  readonly fileBytes: number | null;
  readonly pidsMax: number | null;
  readonly cpuMax: string | null;
}

/** Serialisable view of one sandbox, served by the plugin-host health/status endpoint. */
export interface SandboxStatus {
  readonly pluginId: string;
  readonly state: SandboxState;
  readonly pid: number | null;
  readonly childPid: number | null;
  readonly startedAt: string | null;
  readonly readyAt: string | null;
  readonly startupMs: number | null;
  readonly memoryBytes: number | null;
  readonly cgroup: SandboxCgroupUsage | null;
  readonly exitCode: number | null;
  readonly error: string | null;
}
