import { describe, expect, test } from "bun:test";
import { type CgroupProbe, cgroupRootCandidates, resolveSandboxCgroupRoot } from "./cgroup.ts";

const FULL = ["cpu", "memory", "pids"] as const;

function probe(options: {
  self: string;
  writable: readonly string[];
  controllers: Readonly<Record<string, readonly string[]>>;
}): CgroupProbe {
  return {
    readSelfCgroup: async () => options.self,
    canCreateChild: async (path) => options.writable.includes(path),
    controllers: async (path) => options.controllers[path] ?? [],
  };
}

describe("cgroup v2 root discovery", () => {
  test("offers the mount and every ancestor of the container cgroup, deepest first", () => {
    expect(
      cgroupRootCandidates(
        "/sys/fs/cgroup",
        "/user.slice/user-501.slice/user@501.service/user.slice/libpod-abc123.scope/container",
      ),
    ).toEqual([
      "/sys/fs/cgroup",
      "/sys/fs/cgroup/user.slice/user-501.slice/user@501.service/user.slice/libpod-abc123.scope/container",
      "/sys/fs/cgroup/user.slice/user-501.slice/user@501.service/user.slice/libpod-abc123.scope",
      "/sys/fs/cgroup/user.slice/user-501.slice/user@501.service/user.slice",
      "/sys/fs/cgroup/user.slice/user-501.slice/user@501.service",
      "/sys/fs/cgroup/user.slice/user-501.slice",
      "/sys/fs/cgroup/user.slice",
    ]);

    expect(
      cgroupRootCandidates("/sys/fs/cgroup/", "/machine.slice/libpod-abc123.scope/container"),
    ).toEqual([
      "/sys/fs/cgroup",
      "/sys/fs/cgroup/machine.slice/libpod-abc123.scope/container",
      "/sys/fs/cgroup/machine.slice/libpod-abc123.scope",
      "/sys/fs/cgroup/machine.slice",
    ]);

    expect(cgroupRootCandidates("/sys/fs/cgroup", "/system.slice/docker-abc123.scope")).toEqual([
      "/sys/fs/cgroup",
      "/sys/fs/cgroup/system.slice/docker-abc123.scope",
      "/sys/fs/cgroup/system.slice",
    ]);
  });

  test("falls back to the mount when the cgroup path is the root", () => {
    expect(cgroupRootCandidates("/sys/fs/cgroup", "/")).toEqual(["/sys/fs/cgroup"]);
  });

  test("uses the mount when it is writable (rootful engines)", async () => {
    const root = await resolveSandboxCgroupRoot(
      "/sys/fs/cgroup",
      probe({
        self: "/machine.slice/libpod-abc123.scope/container",
        writable: ["/sys/fs/cgroup"],
        controllers: { "/sys/fs/cgroup": FULL },
      }),
    );

    expect(root).toBe("/sys/fs/cgroup");
  });

  test("uses the systemd-delegated parent when the mount is read-only (rootless Podman)", async () => {
    const delegated = "/sys/fs/cgroup/user.slice/user-501.slice/user@501.service/user.slice";
    const root = await resolveSandboxCgroupRoot(
      "/sys/fs/cgroup",
      probe({
        self: "/user.slice/user-501.slice/user@501.service/user.slice/libpod-abc123.scope/container",
        writable: [delegated],
        controllers: {
          "/sys/fs/cgroup": FULL,
          [delegated]: FULL,
        },
      }),
    );

    expect(root).toBe(delegated);
  });

  test("uses the cgroupfs parent when Podman names it libpod_parent", async () => {
    const delegated = "/sys/fs/cgroup/libpod_parent";
    const root = await resolveSandboxCgroupRoot(
      "/sys/fs/cgroup",
      probe({
        self: "/libpod_parent/libpod-abc123.scope/container",
        writable: [delegated],
        controllers: {
          "/sys/fs/cgroup": FULL,
          [delegated]: FULL,
        },
      }),
    );

    expect(root).toBe(delegated);
  });

  test("prefers the deepest writable ancestor the container owns", async () => {
    const scope = "/sys/fs/cgroup/system.slice/docker-abc123.scope";
    const root = await resolveSandboxCgroupRoot(
      "/sys/fs/cgroup",
      probe({
        self: "/system.slice/docker-abc123.scope",
        writable: [scope, "/sys/fs/cgroup/system.slice"],
        controllers: { "/sys/fs/cgroup": FULL, [scope]: FULL },
      }),
    );

    expect(root).toBe(scope);
  });

  test("skips candidates without the controllers the sandbox limits need", async () => {
    const delegated = "/sys/fs/cgroup/user.slice";
    const root = await resolveSandboxCgroupRoot(
      "/sys/fs/cgroup",
      probe({
        self: "/user.slice/libpod-abc123.scope/container",
        writable: ["/sys/fs/cgroup", delegated],
        controllers: {
          "/sys/fs/cgroup": ["memory", "pids"],
          [delegated]: FULL,
        },
      }),
    );

    expect(root).toBe(delegated);
  });

  test("explains which paths were tried when nothing is writable", async () => {
    await expect(
      resolveSandboxCgroupRoot(
        "/sys/fs/cgroup",
        probe({
          self: "/user.slice/libpod-abc123.scope/container",
          writable: [],
          controllers: { "/sys/fs/cgroup": FULL, "/sys/fs/cgroup/user.slice": FULL },
        }),
      ),
    ).rejects.toThrow(/Tried: \/sys\/fs\/cgroup, .*\/sys\/fs\/cgroup\/user\.slice/);
  });
});
