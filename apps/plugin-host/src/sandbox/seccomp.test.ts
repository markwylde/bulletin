import { describe, expect, test } from "bun:test";
import {
  buildSeccompPolicy,
  FORBIDDEN_SYSCALLS,
  forbiddenInAllowlist,
  sandboxArch,
} from "./seccomp.ts";

describe("seccomp profile", () => {
  test("is a bare default-deny Kafel policy that nsjail accepts via --seccomp_string", () => {
    const policy = buildSeccompPolicy("arm64");

    expect(policy.startsWith("#define")).toBe(true);
    expect(policy).toContain("ALLOW {");
    expect(policy.endsWith("}")).toBe(true);
    // A named `POLICY {}` block is silently ignored by nsjail 3.4 when passed as a string.
    expect(policy).not.toContain("POLICY ");
  });

  test.each(["arm64", "x64"] as const)(
    "allows the syscalls a broker-connected Bun needs (%s)",
    (arch) => {
      const policy = buildSeccompPolicy(arch);

      for (const syscall of [
        "execve",
        "clone",
        "mmap",
        "openat",
        "read",
        "write",
        "socket",
        "connect",
        "sendmsg",
        "futex",
        "SYS_epoll_pwait2",
        "SYS_fstat",
        "SYS_uname",
        "SYS_close_range",
      ]) {
        expect(policy).toContain(syscall);
      }
    },
  );

  test.each(["arm64", "x64"] as const)(
    "never allows escape or credential syscalls (%s)",
    (arch) => {
      const policy = buildSeccompPolicy(arch);

      for (const syscall of FORBIDDEN_SYSCALLS) {
        expect(new RegExp(`\\b${syscall}\\b`).test(policy)).toBe(false);
      }
    },
  );

  test("keeps the newer mount API and cross-process families forbidden", () => {
    for (const syscall of [
      "fsopen",
      "fsmount",
      "open_tree",
      "move_mount",
      "mount_setattr",
      "pidfd_getfd",
      "process_vm_readv",
      "kcmp",
      "name_to_handle_at",
      "io_uring_enter",
      "settimeofday",
      "sethostname",
    ]) {
      expect(FORBIDDEN_SYSCALLS as readonly string[]).toContain(syscall);
    }
  });

  test("fails the build if a forbidden syscall is added to the allowlist", () => {
    expect(forbiddenInAllowlist(["read", "write"])).toEqual([]);
    expect(forbiddenInAllowlist(["read", "mount", "write"])).toEqual(["mount"]);
    expect(forbiddenInAllowlist(["read", "SYS_pidfd_getfd"])).toEqual(["pidfd_getfd"]);
  });

  test("uses the right numeric aliases per architecture", () => {
    expect(buildSeccompPolicy("arm64")).toContain("#define SYS_uname 160");
    expect(buildSeccompPolicy("arm64")).toContain("#define SYS_fstat 80");
    expect(buildSeccompPolicy("x64")).toContain("#define SYS_uname 63");
    expect(buildSeccompPolicy("x64")).toContain("#define SYS_fstat 5");
    // Bun sets up thread-local storage with arch_prctl on x86_64; without it the sandbox
    // dies with SIGSYS before the broker handshake.
    expect(buildSeccompPolicy("x64")).toContain("#define SYS_arch_prctl 158");
    expect(buildSeccompPolicy("arm64")).not.toContain("arch_prctl");
  });

  test("rejects an architecture without a profile", () => {
    expect(sandboxArch("arm64")).toBe("arm64");
    expect(sandboxArch("x64")).toBe("x64");
    expect(sandboxArch("aarch64")).toBe("arm64");
    expect(sandboxArch("x86_64")).toBe("x64");
    expect(() => sandboxArch("riscv64")).toThrow("Unsupported sandbox architecture");
  });
});
