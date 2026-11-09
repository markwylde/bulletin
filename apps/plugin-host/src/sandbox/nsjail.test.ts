import { describe, expect, test } from "bun:test";
import {
  buildNsjailArgs,
  JAIL_BUNDLE_PATH,
  JAIL_SOCKET_PATH,
  NSJAIL_ENVIRONMENT,
  type NsjailSandbox,
  sandboxUid,
} from "./nsjail.ts";
import { DEFAULT_SANDBOX_LIMITS } from "./types.ts";

function sandbox(overrides: Partial<NsjailSandbox> = {}): NsjailSandbox {
  return {
    pluginId: "sandbox-demo",
    rootfsPath: "/opt/plugin-rootfs",
    bundlePath: "/app/apps/plugin-host/src/spike/plugin",
    socketPath: "/run/plugin-host/broker.sock",
    uid: 12_345,
    gid: 12_345,
    cgroupV2Mount: "/sys/fs/cgroup",
    seccompPolicy: "ALLOW { read }",
    limits: DEFAULT_SANDBOX_LIMITS,
    command: ["/bin/bun", "/plugin/server.ts"],
    ...overrides,
  };
}

function valuesOf(args: readonly string[], flag: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1] !== undefined) {
      values.push(args[index + 1] as string);
    }
  }

  return values;
}

function firstValue(args: readonly string[], flag: string): string {
  const [value] = valuesOf(args, flag);

  if (value === undefined) {
    throw new Error(`Missing ${flag}`);
  }

  return value;
}

describe("nsjail arguments", () => {
  test("maps the plugin UID and GID first and keeps the setup mapping for nsjail", () => {
    const args = buildNsjailArgs(sandbox());

    expect(valuesOf(args, "--user")).toEqual(["12345:12345:1", "0:0:1"]);
    expect(valuesOf(args, "--group")).toEqual(["12345:12345:1", "0:0:1"]);
    expect(firstValue(args, "--hostname")).toBe("plugin-sandbox-demo");
  });

  test("uses nsjail defaults for an empty network, PID and mount namespace", () => {
    const args = buildNsjailArgs(sandbox());

    expect(args).not.toContain("--disable_clone_newnet");
    expect(args).not.toContain("--disable_clone_newpid");
    expect(args).not.toContain("--disable_clone_newns");
    expect(args).not.toContain("--keep_env");
  });

  test("mounts only the read-only bundle, the broker socket and a private tmpfs", () => {
    const args = buildNsjailArgs(sandbox());

    expect(valuesOf(args, "--bindmount_ro")).toContain(
      `/app/apps/plugin-host/src/spike/plugin:${JAIL_BUNDLE_PATH}`,
    );
    expect(valuesOf(args, "--bindmount")).toEqual([
      `/run/plugin-host/broker.sock:${JAIL_SOCKET_PATH}`,
    ]);
    expect(valuesOf(args, "--tmpfsmount")).toEqual(["/proc", "/tmp"]);
    expect(args).toContain("--disable_proc");
  });

  test("applies cgroup v2 limits, rlimits and the wall-clock watchdog", () => {
    const args = buildNsjailArgs(sandbox());

    expect(args).toContain("--use_cgroupv2");
    expect(firstValue(args, "--cgroupv2_mount")).toBe("/sys/fs/cgroup");
    expect(firstValue(args, "--cgroup_mem_max")).toBe(String(DEFAULT_SANDBOX_LIMITS.memoryBytes));
    expect(firstValue(args, "--cgroup_pids_max")).toBe(String(DEFAULT_SANDBOX_LIMITS.pids));
    expect(firstValue(args, "--cgroup_cpu_ms_per_sec")).toBe(
      String(DEFAULT_SANDBOX_LIMITS.cpuMsPerSecond),
    );
    expect(firstValue(args, "--rlimit_nproc")).toBe(String(DEFAULT_SANDBOX_LIMITS.nproc));
    expect(firstValue(args, "--rlimit_nofile")).toBe(String(DEFAULT_SANDBOX_LIMITS.nofile));
    expect(firstValue(args, "--rlimit_fsize")).toBe(String(DEFAULT_SANDBOX_LIMITS.fileSizeMb));
    expect(firstValue(args, "--time_limit")).toBe(String(DEFAULT_SANDBOX_LIMITS.wallClockSeconds));
  });

  test("passes the seccomp profile and an empty environment plus non-secret values", () => {
    const args = buildNsjailArgs(sandbox());

    expect(firstValue(args, "--seccomp_string")).toBe("ALLOW { read }");
    expect(valuesOf(args, "--env")).toEqual([
      "HOME=/tmp",
      "TMPDIR=/tmp",
      "PLUGIN_ID=sandbox-demo",
      `PLUGIN_SOCKET=${JAIL_SOCKET_PATH}`,
    ]);
  });

  test("puts the jail command after the argument separator", () => {
    const args = buildNsjailArgs(sandbox());
    const separator = args.indexOf("--");

    expect(separator).toBeGreaterThan(0);
    expect(args.slice(separator + 1)).toEqual(["/bin/bun", "/plugin/server.ts"]);
  });

  test("gives nsjail only the minimal supervisor environment", () => {
    expect(Object.keys(NSJAIL_ENVIRONMENT).sort()).toEqual(["HOME", "PATH"]);
  });

  test("rejects unsafe or malformed sandbox settings", () => {
    expect(() => buildNsjailArgs(sandbox({ pluginId: "Bad Id" }))).toThrow("Invalid plugin id");
    expect(() => buildNsjailArgs(sandbox({ pluginId: "" }))).toThrow("Invalid plugin id");
    expect(() => buildNsjailArgs(sandbox({ uid: 0 }))).toThrow("uid must be a positive integer");
    expect(() => buildNsjailArgs(sandbox({ command: ["bun"] }))).toThrow(
      "Sandbox command must be an absolute path",
    );
    expect(() =>
      buildNsjailArgs(
        sandbox({
          limits: { ...DEFAULT_SANDBOX_LIMITS, memoryBytes: 0 },
        }),
      ),
    ).toThrow("memoryBytes must be a positive integer");
  });
});

describe("sandbox uid", () => {
  test("is deterministic and inside the per-plugin range", () => {
    const first = sandboxUid("sandbox-demo");

    expect(sandboxUid("sandbox-demo")).toBe(first);
    expect(first).toBeGreaterThanOrEqual(10_000);
    expect(first).toBeLessThan(60_000);
    expect(sandboxUid("another-plugin")).not.toBe(first);
  });
});
