import { randomUUID } from "node:crypto";
import { mkdir, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * nsjail needs a cgroup v2 directory it can create children in. Rootful Docker/Podman give
 * the container the host root, which works. Rootless Podman mounts the host root read-only;
 * the writable place is the systemd-delegated `user.slice` directory that contains the
 * container's scope. Resolving this at startup keeps the compose file identical on both.
 */
export interface CgroupProbe {
  /** Path from `/proc/self/cgroup`, e.g. `/user.slice/.../libpod-abc.scope/container`. */
  readSelfCgroup(): Promise<string>;
  canCreateChild(path: string): Promise<boolean>;
  controllers(path: string): Promise<readonly string[]>;
}

const SCOPE_PATTERN = /^(?:libpod|docker)-[0-9a-f]+\.scope$/;
const REQUIRED_CONTROLLERS = ["memory", "pids", "cpu"] as const;

/** Candidate cgroup roots in preference order. Exported for tests. */
export function cgroupRootCandidates(mount: string, selfCgroup: string): string[] {
  const normalizedMount = mount.replace(/\/+$/, "");
  const parts = selfCgroup.split("/").filter((part) => part !== "");
  const scopeIndex = parts.findIndex((part) => SCOPE_PATTERN.test(part));
  const candidates = [normalizedMount];

  if (scopeIndex > 0) {
    candidates.push(join(normalizedMount, ...parts.slice(0, scopeIndex)));
  }

  return [...new Set(candidates)];
}

async function canCreateChild(path: string): Promise<boolean> {
  const probe = join(path, `.plugin-host-${randomUUID()}`);

  try {
    await mkdir(probe);
    return true;
  } catch {
    return false;
  } finally {
    await rmdir(probe).catch(() => undefined);
  }
}

async function controllers(path: string): Promise<readonly string[]> {
  try {
    const text = await readFile(join(path, "cgroup.controllers"), "utf8");
    return text
      .trim()
      .split(/\s+/)
      .filter((value) => value !== "");
  } catch {
    return [];
  }
}

export const defaultCgroupProbe: CgroupProbe = {
  async readSelfCgroup() {
    const text = await readFile("/proc/self/cgroup", "utf8");
    const line = text
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("0::"));

    return line?.slice("0::".length) ?? "";
  },
  canCreateChild,
  controllers,
};

/**
 * Picks the first candidate that accepts a child cgroup and exposes the controllers the
 * sandbox limits need. Throws with the tried paths so a failed start is diagnosable.
 */
export async function resolveSandboxCgroupRoot(
  mount: string,
  probe: CgroupProbe = defaultCgroupProbe,
): Promise<string> {
  const candidates = cgroupRootCandidates(mount, await probe.readSelfCgroup());

  for (const candidate of candidates) {
    const available = await probe.controllers(candidate);

    if (!REQUIRED_CONTROLLERS.every((controller) => available.includes(controller))) {
      continue;
    }

    if (await probe.canCreateChild(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `No writable cgroup v2 root with ${REQUIRED_CONTROLLERS.join("/")} controllers. ` +
      `Tried: ${candidates.join(", ")}. The plugin-host container needs a writable ` +
      `cgroup hierarchy (cgroup: host plus a writable /sys/fs/cgroup mount).`,
  );
}
