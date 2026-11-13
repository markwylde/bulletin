import { stat as fsStat } from "node:fs/promises";
import { join } from "node:path";
import { type CgroupProbe, resolveSandboxCgroupRoot } from "./cgroup.ts";
import { readProcFile } from "./procfs.ts";

/**
 * Checks the container contract ADR 0009 requires before the broker and supervisor start.
 *
 * nsjail fails with terse errors when a capability, the outer seccomp profile or the cgroup
 * hierarchy is missing. Each has a different fix (compose `cap_add`, `security_opt`,
 * `cgroup: host`), so the preflight aggregates all findings into one actionable error and
 * refuses to run plugin code without them instead of quietly degrading.
 */

/** Linux capability numbers used by the nsjail setup (see `capabilities(7)`). */
export const CAP_CHOWN = 0;
export const CAP_SETGID = 6;
export const CAP_SETUID = 7;
export const CAP_SYS_ADMIN = 21;

const REQUIRED_CAPABILITIES: Readonly<Record<number, string>> = {
  [CAP_CHOWN]: "CAP_CHOWN",
  [CAP_SETGID]: "CAP_SETGID",
  [CAP_SETUID]: "CAP_SETUID",
  [CAP_SYS_ADMIN]: "CAP_SYS_ADMIN",
};

/** Only `SECCOMP_MODE_DISABLED` lets nsjail create a user namespace under Docker. */
const SECCOMP_MODE_DISABLED = 0;
const EXECUTABLE_BITS = 0o111;

export interface FileStat {
  readonly mode: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

/** Host seam: every value that differs between the container and a unit test. */
export interface PreflightHost {
  readonly platform: string;
  stat(path: string): Promise<FileStat | undefined>;
  readText(path: string): Promise<string | undefined>;
}

export interface SandboxPreflightOptions {
  readonly nsjailPath: string;
  readonly rootfsPath: string;
  readonly cgroupV2Mount: string;
  readonly host?: PreflightHost;
  readonly resolveCgroup?: (mount: string, probe?: CgroupProbe) => Promise<string>;
}

export interface SandboxPreflightResult {
  /** Writable cgroup v2 root the supervisor passes to nsjail. */
  readonly cgroupRoot: string;
}

export const nodePreflightHost: PreflightHost = {
  platform: process.platform,
  async stat(path) {
    try {
      return await fsStat(path);
    } catch {
      return undefined;
    }
  },
  readText: readProcFile,
};

/** Parses a `CapEff` hex mask from `/proc/self/status`. */
export function parseCapabilityMask(status: string): bigint | undefined {
  const match = /^CapEff:\s*([0-9a-fA-F]+)$/m.exec(status);
  return match?.[1] === undefined ? undefined : BigInt(`0x${match[1]}`);
}

/** Parses the seccomp mode from `/proc/self/status` (`0` disabled, `2` filter). */
export function parseSeccompMode(status: string): number | undefined {
  const match = /^Seccomp:\s*(\d+)$/m.exec(status);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** Capability names from {@link REQUIRED_CAPABILITIES} absent from an effective mask. */
export function missingCapabilities(mask: bigint): string[] {
  return Object.entries(REQUIRED_CAPABILITIES)
    .filter(([bit]) => ((mask >> BigInt(bit)) & 1n) === 0n)
    .map(([, name]) => name)
    .sort();
}

export function capabilityMask(bits: readonly number[]): bigint {
  return bits.reduce((mask, bit) => mask | (1n << BigInt(bit)), 0n);
}

async function checkFiles(
  options: SandboxPreflightOptions,
  host: PreflightHost,
  issues: string[],
): Promise<void> {
  const nsjail = await host.stat(options.nsjailPath);

  if (nsjail?.isFile() !== true) {
    issues.push(`nsjail is missing at ${options.nsjailPath}`);
  } else if ((nsjail.mode & EXECUTABLE_BITS) === 0) {
    issues.push(`nsjail at ${options.nsjailPath} is not executable`);
  }

  const rootfs = await host.stat(options.rootfsPath);

  if (rootfs?.isDirectory() !== true) {
    issues.push(`sandbox root filesystem is missing at ${options.rootfsPath}`);
  }

  const bun = await host.stat(join(options.rootfsPath, "bin/bun"));

  if (bun?.isFile() !== true) {
    issues.push(
      `sandbox root filesystem has no Bun runtime at ${join(options.rootfsPath, "bin/bun")}`,
    );
  }
}

async function checkCapabilities(host: PreflightHost, issues: string[]): Promise<void> {
  const status = await host.readText("/proc/self/status");

  if (status === undefined) {
    issues.push("/proc/self/status is unreadable, so container capabilities cannot be verified");
    return;
  }

  const mask = parseCapabilityMask(status);

  if (mask === undefined) {
    issues.push("CapEff is missing from /proc/self/status");
  } else {
    const missing = missingCapabilities(mask);

    if (missing.length > 0) {
      issues.push(
        `container is missing ${missing.join(", ")}; add the missing capabilities to the ` +
          "plugin-host service (engine defaults plus SYS_ADMIN)",
      );
    }
  }

  const seccomp = parseSeccompMode(status);

  if (seccomp === undefined) {
    issues.push("Seccomp mode is missing from /proc/self/status");
  } else if (seccomp !== SECCOMP_MODE_DISABLED) {
    issues.push(
      "the outer container runs under a seccomp filter, which rejects CLONE_NEWUSER; " +
        "set security_opt: [seccomp=unconfined] on plugin-host (the jail applies its own filter)",
    );
  }
}

/**
 * Verifies the ADR 0009 container contract and returns the writable cgroup v2 root.
 * Throws one aggregated error that names every problem and its compose fix.
 */
export async function runSandboxPreflight(
  options: SandboxPreflightOptions,
): Promise<SandboxPreflightResult> {
  const host = options.host ?? nodePreflightHost;

  if (host.platform !== "linux") {
    throw new Error(
      `The plugin sandbox needs Linux (nsjail); this host is ${host.platform}. ` +
        "Run plugin-host in the compose stack.",
    );
  }

  const issues: string[] = [];
  await checkFiles(options, host, issues);
  await checkCapabilities(host, issues);
  const resolveCgroup = options.resolveCgroup ?? resolveSandboxCgroupRoot;
  let cgroupRoot: string | undefined;

  try {
    cgroupRoot = await resolveCgroup(options.cgroupV2Mount);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  if (issues.length > 0) {
    throw new Error(`Plugin sandbox preflight failed:\n- ${issues.join("\n- ")}`);
  }

  if (cgroupRoot === undefined) {
    throw new Error("Plugin sandbox preflight failed: no cgroup v2 root was resolved");
  }

  return { cgroupRoot };
}
