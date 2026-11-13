import { describe, expect, test } from "bun:test";
import {
  CAP_CHOWN,
  CAP_SETGID,
  CAP_SETUID,
  CAP_SYS_ADMIN,
  capabilityMask,
  missingCapabilities,
  type PreflightHost,
  parseCapabilityMask,
  parseSeccompMode,
  runSandboxPreflight,
} from "./preflight.ts";

const ALL_CAPS = capabilityMask([CAP_CHOWN, CAP_SETGID, CAP_SETUID, CAP_SYS_ADMIN]);

function status(options: { caps?: bigint; seccomp?: number } = {}): string {
  return [
    "Name:\tplugin-host",
    `CapEff:\t${(options.caps ?? ALL_CAPS).toString(16).padStart(16, "0")}`,
    `Seccomp:\t${options.seccomp ?? 0}`,
    "",
  ].join("\n");
}

interface HostOptions {
  readonly platform?: string;
  readonly files?: Readonly<Record<string, "file" | "directory" | "executable">>;
  readonly status?: string;
}

function host(options: HostOptions = {}): PreflightHost {
  const files = options.files ?? {
    "/usr/bin/nsjail": "executable",
    "/opt/plugin-rootfs": "directory",
    "/opt/plugin-rootfs/bin/bun": "executable",
  };

  return {
    platform: options.platform ?? "linux",
    async stat(path) {
      const kind = files[path];

      if (kind === undefined) {
        return undefined;
      }

      return {
        mode: kind === "executable" ? 0o755 : 0o644,
        isFile: () => kind !== "directory",
        isDirectory: () => kind === "directory",
      };
    },
    async readText(path) {
      return path === "/proc/self/status" ? (options.status ?? status()) : undefined;
    },
  };
}

function preflight(hostValue: PreflightHost, cgroupRoot = "/sys/fs/cgroup") {
  return runSandboxPreflight({
    nsjailPath: "/usr/bin/nsjail",
    rootfsPath: "/opt/plugin-rootfs",
    cgroupV2Mount: "/sys/fs/cgroup",
    host: hostValue,
    resolveCgroup: async () => cgroupRoot,
  });
}

describe("sandbox preflight", () => {
  test("passes the ADR 0009 container contract and returns the cgroup root", async () => {
    await expect(preflight(host(), "/sys/fs/cgroup/user.slice")).resolves.toEqual({
      cgroupRoot: "/sys/fs/cgroup/user.slice",
    });
  });

  test("refuses a host that is not Linux", async () => {
    await expect(preflight(host({ platform: "darwin" }))).rejects.toThrow(
      "The plugin sandbox needs Linux",
    );
  });

  test("names the missing nsjail binary and runtime in the root filesystem", async () => {
    await expect(
      preflight(
        host({
          files: {
            "/opt/plugin-rootfs": "directory",
          },
        }),
      ),
    ).rejects.toThrow(/nsjail is missing at \/usr\/bin\/nsjail[\s\S]*no Bun runtime/);
  });

  test("rejects a non-executable nsjail or missing root filesystem", async () => {
    await expect(
      preflight(
        host({
          files: {
            "/usr/bin/nsjail": "file",
            "/opt/plugin-rootfs/bin/bun": "executable",
          },
        }),
      ),
    ).rejects.toThrow(/not executable[\s\S]*root filesystem is missing/);
  });

  test("lists every missing container capability", async () => {
    const caps = capabilityMask([CAP_CHOWN, CAP_SETUID]);

    await expect(preflight(host({ status: status({ caps }) }))).rejects.toThrow(
      /missing CAP_SETGID, CAP_SYS_ADMIN/,
    );
  });

  test("rejects the outer seccomp filter that blocks CLONE_NEWUSER", async () => {
    await expect(preflight(host({ status: status({ seccomp: 2 }) }))).rejects.toThrow(
      /seccomp=unconfined/,
    );
  });

  test("rejects an unreadable or malformed /proc/self/status", async () => {
    await expect(preflight(host({ status: "" }))).rejects.toThrow(/CapEff is missing/);
    await expect(preflight(host({ status: "" }))).rejects.toThrow(/Seccomp mode is missing/);
  });

  test("reports why no writable cgroup root exists", async () => {
    await expect(
      runSandboxPreflight({
        nsjailPath: "/usr/bin/nsjail",
        rootfsPath: "/opt/plugin-rootfs",
        cgroupV2Mount: "/sys/fs/cgroup",
        host: host(),
        resolveCgroup: async () => {
          throw new Error("No writable cgroup v2 root with memory/pids/cpu controllers");
        },
      }),
    ).rejects.toThrow(/No writable cgroup v2 root/);
  });

  test("parses capability and seccomp masks", () => {
    expect(parseCapabilityMask("CapEff:\t00000000a80425fb")).toBe(0xa80425fbn);
    expect(parseCapabilityMask("Name:\tx")).toBeUndefined();
    expect(parseSeccompMode("Seccomp:\t0")).toBe(0);
    expect(parseSeccompMode("Seccomp:\t2")).toBe(2);
    expect(parseSeccompMode("Name:\tx")).toBeUndefined();
    expect(missingCapabilities(ALL_CAPS)).toEqual([]);
  });
});
