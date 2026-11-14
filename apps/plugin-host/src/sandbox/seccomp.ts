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
    // x86_64 keeps legacy syscalls that arm64 never had. Bun and its libc use them on x64
    // (arch_prctl for thread-local storage at startup, and the non-*at file, pipe and poll
    // forms). Each is the legacy spelling of a call already allowed above (openat, pipe2,
    // ppoll, dup3, epoll_pwait, getdents64, ...), so none adds a capability.
    access: 21,
    arch_prctl: 158,
    dup2: 33,
    epoll_create: 213,
    epoll_wait: 232,
    getdents: 78,
    lstat: 6,
    mkdir: 83,
    open: 2,
    pipe: 22,
    poll: 7,
    readlink: 89,
    rename: 82,
    rmdir: 84,
    select: 23,
    stat: 4,
    time: 201,
    unlink: 87,
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
  const conflicts = forbiddenInAllowlist(allowed);

  if (conflicts.length > 0) {
    throw new Error(`Seccomp allowlist contains forbidden syscalls: ${conflicts.join(", ")}`);
  }

  return [...defines, "", "ALLOW {", `  ${allowed.join(", ")}`, "}"].join("\n");
}

/** Names that a policy emits but the forbidden list says must stay denied, including aliases. */
export function forbiddenInAllowlist(allowed: readonly string[]): string[] {
  const emitted = new Set(allowed);

  return FORBIDDEN_SYSCALLS.filter(
    (syscall) => emitted.has(syscall) || emitted.has(`SYS_${syscall}`),
  );
}

/**
 * Syscalls that must never appear in the plugin profile. Everything not in the allowlist is
 * already denied by Kafel's default-deny action; this list is the reviewable boundary and
 * makes an accidental addition to {@link COMMON_ALLOW} fail the build instead of weakening
 * the sandbox. It includes the newer mount API, cross-process inspection, keyring and
 * host-administration families that are not named in older Kafel tables.
 */
export const FORBIDDEN_SYSCALLS = [
  "acct",
  "add_key",
  "adjtimex",
  "bpf",
  "capset",
  "chroot",
  "clock_adjtime",
  "clock_settime",
  "create_module",
  "delete_module",
  "fanotify_init",
  "finit_module",
  "fsconfig",
  "fsmount",
  "fsopen",
  "fspick",
  "init_module",
  "io_uring_enter",
  "io_uring_register",
  "io_uring_setup",
  "ioperm",
  "iopl",
  "kcmp",
  "kexec_file_load",
  "kexec_load",
  "keyctl",
  "lookup_dcookie",
  "mount",
  "mount_setattr",
  "move_mount",
  "name_to_handle_at",
  "nfsservctl",
  "open_by_handle_at",
  "open_tree",
  "perf_event_open",
  "personality",
  "pidfd_getfd",
  "pivot_root",
  "process_vm_readv",
  "process_vm_writev",
  "ptrace",
  "quotactl",
  "reboot",
  "request_key",
  "setdomainname",
  "setfsgid",
  "setfsuid",
  "setgid",
  "setgroups",
  "sethostname",
  "setns",
  "setregid",
  "setresgid",
  "setresuid",
  "setreuid",
  "settimeofday",
  "setuid",
  "swapoff",
  "swapon",
  "syslog",
  "umount2",
  "unshare",
  "uselib",
  "userfaultfd",
  "vm86",
  "vm86old",
] as const;
