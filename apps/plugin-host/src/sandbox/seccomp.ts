/**
 * Default-deny seccomp profile for plugin processes (ADR 0009).
 *
 * Kafel (nsjail's policy language) denies every syscall that is not listed. The common
 * allowlist below is enough for a Bun plugin that talks to the broker over a Unix socket;
 * syscalls that Kafel's bundled tables name differently per architecture, or do not name at
 * all, are allowed through architecture-specific numeric aliases.
 *
 * Dangerous families stay out on purpose: no `ptrace`, namespaces/mounts, module or BPF
 * loading, keyring or handle syscalls, `setuid`/`setgid`, or host administration calls.
 */

export type SandboxArch = "arm64" | "x64";

const COMMON_ALLOW = [
  "accept",
  "accept4",
  "bind",
  "brk",
  "chdir",
  "clock_getres",
  "clock_gettime",
  "clock_nanosleep",
  "clone",
  "close",
  "connect",
  "dup",
  "dup3",
  "epoll_create1",
  "epoll_ctl",
  "epoll_pwait",
  "eventfd2",
  "execve",
  "exit",
  "exit_group",
  "faccessat",
  "fchdir",
  "fchmod",
  "fchmodat",
  "fcntl",
  "fdatasync",
  "fstatfs",
  "fsync",
  "ftruncate",
  "futex",
  "getcwd",
  "getdents64",
  "getegid",
  "geteuid",
  "getgid",
  "getpid",
  "getppid",
  "getrandom",
  "getrlimit",
  "getrusage",
  "getsockname",
  "getsockopt",
  "gettid",
  "gettimeofday",
  "getuid",
  "ioctl",
  "kill",
  "listen",
  "lseek",
  "madvise",
  "membarrier",
  "memfd_create",
  "mincore",
  "mkdirat",
  "mmap",
  "mprotect",
  "mremap",
  "msync",
  "munmap",
  "nanosleep",
  "newfstatat",
  "openat",
  "pipe2",
  "ppoll",
  "prctl",
  "pread64",
  "prlimit64",
  "pwrite64",
  "read",
  "readlinkat",
  "readv",
  "recvfrom",
  "recvmsg",
  "renameat",
  "renameat2",
  "restart_syscall",
  "rt_sigaction",
  "rt_sigprocmask",
  "rt_sigreturn",
  "sched_getaffinity",
  "sched_getparam",
  "sched_getscheduler",
  "sched_setaffinity",
  "sched_yield",
  "sendmsg",
  "sendto",
  "set_robust_list",
  "setsockopt",
  "set_tid_address",
  "shutdown",
  "sigaltstack",
  "socket",
  "statfs",
  "symlinkat",
  "tgkill",
  "umask",
  "unlinkat",
  "utimensat",
  "wait4",
  "write",
  "writev",
] as const;

/**
 * Kafel in nsjail 3.4 predates several syscalls and uses arch-specific names for a few
 * others (`newuname` on arm64). Numeric aliases keep one logical allowlist portable.
 */
const ARCH_SYSCALLS: Readonly<Record<SandboxArch, Readonly<Record<string, number>>>> = {
  arm64: {
    clone3: 435,
    close_range: 436,
    epoll_pwait2: 441,
    faccessat2: 439,
    fstat: 80,
    openat2: 437,
    pidfd_open: 434,
    rseq: 293,
    sched_setscheduler: 119,
    statx: 291,
    sysinfo: 179,
    uname: 160,
  },
  x64: {
    clone3: 435,
    close_range: 436,
    epoll_pwait2: 441,
    faccessat2: 439,
    fstat: 5,
    openat2: 437,
    pidfd_open: 434,
    rseq: 334,
    sched_setscheduler: 144,
    statx: 332,
    sysinfo: 99,
    uname: 63,
  },
};

const SUPPORTED_ARCHES = Object.keys(ARCH_SYSCALLS) as readonly SandboxArch[];

/** Maps Bun's `process.arch` onto the architectures this profile knows about. */
export function sandboxArch(arch: string): SandboxArch {
  const normalized = arch === "x86_64" ? "x64" : arch === "aarch64" ? "arm64" : arch;

  if (SUPPORTED_ARCHES.includes(normalized as SandboxArch)) {
    return normalized as SandboxArch;
  }

  throw new Error(`Unsupported sandbox architecture: ${arch}`);
}

/** Builds the Kafel policy passed to nsjail with `--seccomp_string`. */
export function buildSeccompPolicy(arch: SandboxArch): string {
  const aliases = ARCH_SYSCALLS[arch];
  const defines = Object.entries(aliases).map(([name, number]) => `#define SYS_${name} ${number}`);
  const aliasNames = Object.keys(aliases).map((name) => `SYS_${name}`);
  const allowed = [...COMMON_ALLOW, ...aliasNames];

  return [...defines, "", "ALLOW {", `  ${allowed.join(", ")}`, "}"].join("\n");
}

/** Syscalls that must never appear in the plugin profile. */
export const FORBIDDEN_SYSCALLS = [
  "bpf",
  "capset",
  "chroot",
  "init_module",
  "io_uring_setup",
  "keyctl",
  "kexec_load",
  "mount",
  "open_by_handle_at",
  "perf_event_open",
  "personality",
  "pivot_root",
  "ptrace",
  "reboot",
  "setgid",
  "setns",
  "setuid",
  "swapoff",
  "swapon",
  "syslog",
  "unshare",
  "userfaultfd",
] as const;
