import { fileURLToPath } from "node:url";
import { ConfigError, type Env } from "@bulletin/config";
import { DEFAULT_SANDBOX_LIMITS, type SandboxLimits } from "./sandbox/types.ts";

export interface PluginHostConfig {
  /** Absolute path to the nsjail binary. */
  readonly nsjailPath: string;
  /** Minimal root filesystem the jail chroots into. */
  readonly rootfsPath: string;
  /** Host path of the read-only demo bundle spawned at startup. */
  readonly bundlePath: string;
  /** Writable cgroup v2 hierarchy used for per-sandbox limits. */
  readonly cgroupV2Mount: string;
  /** Directory holding the broker socket and other runtime state. */
  readonly stateDir: string;
  readonly limits: SandboxLimits;
  readonly readyTimeoutMs: number;
}

const MB = 1024 * 1024;

function read(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function readInteger(
  env: Env,
  key: string,
  fallback: number,
  bounds: { readonly min: number; readonly max: number },
  issues: string[],
): number {
  const raw = read(env, key);

  if (raw === undefined) {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    issues.push(`${key} must be an integer between ${bounds.min} and ${bounds.max}`);
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) {
    issues.push(`${key} must be an integer between ${bounds.min} and ${bounds.max}`);
    return fallback;
  }

  return value;
}

/**
 * Parses the plugin-host's sandbox settings. Every value has a working development default
 * so `docker compose up --watch` needs no `.env` file (ADR 0002); invalid values fail fast
 * like the shared config loader.
 */
export function loadPluginHostConfig(env: Env = Bun.env): PluginHostConfig {
  const issues: string[] = [];
  const megabytes = (value: number): number => value * MB;

  const limits: SandboxLimits = {
    memoryBytes: megabytes(
      readInteger(
        env,
        "PLUGIN_HOST_MEMORY_MB",
        DEFAULT_SANDBOX_LIMITS.memoryBytes / MB,
        { min: 16, max: 16_384 },
        issues,
      ),
    ),
    cpuMsPerSecond: readInteger(
      env,
      "PLUGIN_HOST_CPU_MS_PER_SECOND",
      DEFAULT_SANDBOX_LIMITS.cpuMsPerSecond,
      { min: 1, max: 1000 },
      issues,
    ),
    pids: readInteger(
      env,
      "PLUGIN_HOST_PIDS",
      DEFAULT_SANDBOX_LIMITS.pids,
      { min: 1, max: 4096 },
      issues,
    ),
    nproc: readInteger(
      env,
      "PLUGIN_HOST_NPROC",
      DEFAULT_SANDBOX_LIMITS.nproc,
      { min: 1, max: 4096 },
      issues,
    ),
    nofile: readInteger(
      env,
      "PLUGIN_HOST_NOFILE",
      DEFAULT_SANDBOX_LIMITS.nofile,
      { min: 16, max: 65_536 },
      issues,
    ),
    fileSizeMb: readInteger(
      env,
      "PLUGIN_HOST_FILESIZE_MB",
      DEFAULT_SANDBOX_LIMITS.fileSizeMb,
      { min: 1, max: 1024 },
      issues,
    ),
    wallClockSeconds: readInteger(
      env,
      "PLUGIN_HOST_WALL_CLOCK_SECONDS",
      DEFAULT_SANDBOX_LIMITS.wallClockSeconds,
      { min: 1, max: 86_400 },
      issues,
    ),
  };

  const readyTimeoutMs = readInteger(
    env,
    "PLUGIN_HOST_READY_TIMEOUT_MS",
    10_000,
    { min: 100, max: 120_000 },
    issues,
  );

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    nsjailPath: read(env, "PLUGIN_HOST_NSJAIL") ?? "/usr/bin/nsjail",
    rootfsPath: read(env, "PLUGIN_HOST_ROOTFS") ?? "/opt/plugin-rootfs",
    bundlePath:
      read(env, "PLUGIN_HOST_BUNDLE") ?? fileURLToPath(new URL("./demo/plugin", import.meta.url)),
    cgroupV2Mount: read(env, "PLUGIN_HOST_CGROUP_ROOT") ?? "/sys/fs/cgroup",
    stateDir: read(env, "PLUGIN_HOST_STATE_DIR") ?? "/run/plugin-host",
    limits,
    readyTimeoutMs,
  };
}
