import { describe, expect, test } from "bun:test";
import { buildSeccompPolicy, FORBIDDEN_SYSCALLS, sandboxArch } from "./seccomp.ts";

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

  test("uses the right numeric aliases per architecture", () => {
    expect(buildSeccompPolicy("arm64")).toContain("#define SYS_uname 160");
    expect(buildSeccompPolicy("arm64")).toContain("#define SYS_fstat 80");
    expect(buildSeccompPolicy("x64")).toContain("#define SYS_uname 63");
    expect(buildSeccompPolicy("x64")).toContain("#define SYS_fstat 5");
  });

  test("rejects an architecture without a profile", () => {
    expect(sandboxArch("arm64")).toBe("arm64");
    expect(sandboxArch("x64")).toBe("x64");
    expect(sandboxArch("aarch64")).toBe("arm64");
    expect(sandboxArch("x86_64")).toBe("x64");
    expect(() => sandboxArch("riscv64")).toThrow("Unsupported sandbox architecture");
  });
});
