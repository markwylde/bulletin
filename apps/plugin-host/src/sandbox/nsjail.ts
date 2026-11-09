import type { SandboxLimits } from "./types.ts";

/** Paths inside the jail that are fixed by the protocol, not by the host layout. */
export const JAIL_SOCKET_PATH = "/run/broker.sock";
export const JAIL_BUNDLE_PATH = "/plugin";

export interface NsjailSandbox {
  readonly pluginId: string;
  readonly rootfsPath: string;
  /** Host path of the read-only plugin bundle, mounted at {@link JAIL_BUNDLE_PATH}. */
  readonly bundlePath: string;
  /** Host path of the broker Unix socket, mounted at {@link JAIL_SOCKET_PATH}. */
  readonly socketPath: string;
  readonly uid: number;
  readonly gid: number;
  /** Root of the writable cgroup v2 hierarchy, e.g. `/sys/fs/cgroup`. */
  readonly cgroupV2Mount: string;
  readonly seccompPolicy: string;
  readonly limits: SandboxLimits;
  /** Command inside the jail, starting with an absolute path. */
  readonly command: readonly string[];
}

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,48}$/;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }

  return value;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim() === "") {
    throw new TypeError(`${name} must not be empty`);
  }

  return value;
}

/**
 * Deterministic per-plugin UID in the container's user namespace. Plugin bundles never run
 * as root; a stable UID also keeps file ownership predictable across restarts.
 */
export function sandboxUid(pluginId: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < pluginId.length; index += 1) {
    hash ^= pluginId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return 10_000 + (hash % 50_000);
}

/**
 * Builds the nsjail argv for one plugin. Every isolation primitive from ADR 0009 is explicit:
 * a per-plugin UID/GID mapping, an empty network namespace (nsjail's default), a read-only
 * bundle, private tmpfs mounts, cgroup v2 limits, rlimits, a wall-clock watchdog and a
 * default-deny seccomp filter. The broker socket is the only mount writable by the plugin.
 */
export function buildNsjailArgs(sandbox: NsjailSandbox): string[] {
  if (!PLUGIN_ID_PATTERN.test(sandbox.pluginId)) {
    throw new TypeError(`Invalid plugin id: ${sandbox.pluginId}`);
  }

  const uid = positiveInteger(sandbox.uid, "uid");
  const gid = positiveInteger(sandbox.gid, "gid");
  const limits = sandbox.limits;
  const command = sandbox.command;

  if (command.length === 0 || !command[0]?.startsWith("/")) {
    throw new TypeError("Sandbox command must be an absolute path");
  }

  return [
    "--mode",
    "o",
    "--quiet",
    "--hostname",
    `plugin-${sandbox.pluginId}`,
    // The first mapping is the process identity; mapping 0 keeps nsjail's namespace setup
    // (mounts, cgroup files) working before it drops to the plugin UID.
    "--user",
    `${uid}:${uid}:1`,
    "--user",
    `0:0:1`,
    "--group",
    `${gid}:${gid}:1`,
    "--group",
    `0:0:1`,
    "--chroot",
    nonEmpty(sandbox.rootfsPath, "rootfsPath"),
    "--cwd",
    "/",
    // A fresh procfs cannot be mounted under locked container mounts; an empty tmpfs hides
    // the host view of /proc instead (the malicious suite asserts /proc is unreadable).
    "--disable_proc",
    "--tmpfsmount",
    "/proc",
    "--bindmount_ro",
    `${nonEmpty(sandbox.bundlePath, "bundlePath")}:${JAIL_BUNDLE_PATH}`,
    "--bindmount",
    `${nonEmpty(sandbox.socketPath, "socketPath")}:${JAIL_SOCKET_PATH}`,
    "--bindmount_ro",
    "/dev/null:/dev/null",
    "--bindmount_ro",
    "/dev/zero:/dev/zero",
    "--bindmount_ro",
    "/dev/urandom:/dev/urandom",
    "--tmpfsmount",
    "/tmp",
    "--rlimit_as",
    "max",
    "--rlimit_core",
    "0",
    "--rlimit_cpu",
    String(positiveInteger(limits.wallClockSeconds, "wallClockSeconds")),
    "--rlimit_fsize",
    String(positiveInteger(limits.fileSizeMb, "fileSizeMb")),
    "--rlimit_nofile",
    String(positiveInteger(limits.nofile, "nofile")),
    "--rlimit_nproc",
    String(positiveInteger(limits.nproc, "nproc")),
    "--time_limit",
    String(positiveInteger(limits.wallClockSeconds, "wallClockSeconds")),
    "--use_cgroupv2",
    "--cgroupv2_mount",
    nonEmpty(sandbox.cgroupV2Mount, "cgroupV2Mount"),
    "--cgroup_mem_max",
    String(positiveInteger(limits.memoryBytes, "memoryBytes")),
    "--cgroup_pids_max",
    String(positiveInteger(limits.pids, "pids")),
    "--cgroup_cpu_ms_per_sec",
    String(positiveInteger(limits.cpuMsPerSecond, "cpuMsPerSecond")),
    "--seccomp_string",
    nonEmpty(sandbox.seccompPolicy, "seccompPolicy"),
    // nsjail starts with an empty environment; only non-secret values are added back.
    "--env",
    "HOME=/tmp",
    "--env",
    "TMPDIR=/tmp",
    "--env",
    `PLUGIN_ID=${sandbox.pluginId}`,
    "--env",
    `PLUGIN_SOCKET=${JAIL_SOCKET_PATH}`,
    "--",
    ...command,
  ];
}

/** The minimal environment handed to the nsjail supervisor process itself. */
export const NSJAIL_ENVIRONMENT: Readonly<Record<string, string>> = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/tmp",
};
