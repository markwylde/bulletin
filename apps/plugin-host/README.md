# plugin-host (spike S2)

Prototype of the brokered plugin sandbox from [ADR 0009](../../docs/adr/0009-plugin-platform.md).
`plugin-platform` reviews and hardens this code; the spike exists to prove the isolation
primitives on Docker and rootless Podman and to measure their cost.

## What runs

- A Bun supervisor (`src/index.ts`) starts one demo plugin (`src/spike/plugin`) under nsjail.
- The plugin runs as its own UID (`sandboxUid(pluginId)`, 10 000–59 999) in fresh user, PID,
  mount, IPC, UTS, cgroup and network namespaces.
- It sees only:
  - a read-only bind of its bundle at `/plugin`,
  - an empty tmpfs at `/proc` (the container's `/proc` is hidden),
  - a private tmpfs at `/tmp`,
  - `/dev/null`, `/dev/zero` and `/dev/urandom`,
  - the broker's Unix socket at `/run/broker.sock` — its only writable mount.
- cgroup v2 enforces memory, pids and CPU; rlimits back up the pids and file-size limits;
  nsjail's `--time_limit` is the wall-clock watchdog.
- A default-deny Kafel seccomp filter (`src/sandbox/seccomp.ts`) allows only the syscalls a
  broker-connected Bun needs and none of the escape or credential families.
- The plugin connects to the broker socket and sends a `hello`; the supervisor only reports
  ready after that handshake.

`GET /sandbox` returns the live status and the sandbox's cgroup values. Readiness includes
the sandbox, so `/health/ready` fails when nsjail cannot start.

## Running it locally

`docker compose up --watch` is still the only setup step. `apps/plugin-host/Dockerfile`
installs nsjail (Alpine 3.22, nsjail 3.4) and builds a minimal read-only root filesystem
with Bun and its musl libraries. The compose service is the only privileged container:

```yaml
cap_add: [SYS_ADMIN]
security_opt: [seccomp=unconfined, label=disable]
cgroup: host
volumes: ["/sys/fs/cgroup:/sys/fs/cgroup:rw"]
```

The engine's default capabilities stay in place (nsjail needs `SETUID`/`SETGID`/`CHOWN` for
the namespace and mount setup); `SYS_ADMIN` is the only addition. The outer seccomp profile
must be unconfined because Docker's default profile rejects `CLONE_NEWUSER`; the sandbox's own
filter still applies. `label=disable` is for SELinux hosts (Podman on Fedora).

Check it:

```bash
docker compose logs plugin-host                 # "sandbox.ready" with startupMs and memory
docker compose exec -T plugin-host bun -e \
  'console.log(await (await fetch("http://127.0.0.1:3004/sandbox")).text())'
```

## Measurement (task 1.2)

The measurement script spawns and stops the demo sandbox N times. It runs one untimed warm-up
first so the shared Bun binary is already in the page cache; with a warm cache the per-sandbox
number is the marginal cost. It also asserts that the cgroup limits were applied.

```bash
docker compose exec -T -e PLUGIN_HOST_ENGINE=podman -e PLUGIN_HOST_MEASURE_ITERATIONS=10 \
  plugin-host bun apps/plugin-host/src/spike/measure.ts
```

On a Docker host, set `PLUGIN_HOST_ENGINE=docker` (or omit it and let the script read
`/proc/self/cgroup`) and run the same command.

### Recorded results

Environment: Podman **6.1.4** (`podman machine`, Linux 7.2.7, cgroup v2), Bun **1.4.0**, aarch64,
default limits (256 MiB, 64 pids, 500 ms CPU/s).

| Engine           | Sandboxes | Spawn → handshake                                         | `memory.current` (warm) | Anonymous (warm) |
| ---------------- | --------- | --------------------------------------------------------- | ----------------------- | ---------------- |
| Podman, rootful  | 10        | min 14 ms, median 20 ms, p95 31 ms, max 31 ms, mean 22 ms | mean 3.6 MiB (3.3–3.9)  | mean 3.0 MiB     |
| Podman, rootless | 5         | min 19 ms, median 25 ms, p95 33 ms, max 33 ms, mean 25 ms | mean 3.5 MiB (3.3–3.9)  | mean 3.0 MiB     |

Other observations (rootful run):

| Metric                                                   | Value                                                |
| -------------------------------------------------------- | ---------------------------------------------------- |
| Sandbox `memory.current`, cold (first sandbox)           | 20.1 MiB (17 MiB of it shared Bun/loader page cache) |
| nsjail + plugin process-tree RSS (includes shared pages) | ≈ 38 MiB                                             |
| cgroup limits applied                                    | memory 256 MiB, pids 64, CPU 500 ms/s, on both roots |

Notes:

- Page cache for the Bun binary and musl loader is charged to the first sandbox that faults
  it in; later sandboxes share those pages and are charged only their private (anonymous)
  memory. That is why a cold sandbox is ~20 MiB and a warm one ~3.6 MiB. The cgroup memory
  limit still bounds the anonymous memory a hostile plugin can allocate.
- Process-tree RSS over-counts shared pages and is only reported for cross-checking.
- The **Docker engine was not available in the environment this spike ran in** (the host's
  `docker` is Podman). The script is engine-agnostic and detects `docker`/`libpod` from
  `/proc/self/cgroup`; the Docker row is produced by the E2E CI job, which runs this command
  on Docker and rootless Podman.

## nsjail / container caveats found

- nsjail 3.4 needs **CAP_SYS_ADMIN** and cgroupns=host to create one cgroup per sandbox.
- Rootful engines let the container write the host cgroup root. Rootless Podman mounts it
  read-only and puts the container under the user's systemd slice, so nsjail's cgroup parent
  must be the delegated `user.slice` directory. `src/sandbox/cgroup.ts` probes the mount and
  then that delegated parent at startup and records which one it used.
- Docker's default seccomp profile blocks `clone`/`unshare` with `CLONE_NEWUSER`, so the
  container needs `seccomp=unconfined`. The jail's own filter is the security boundary.
- The Kafel policy must be the bare `ALLOW { … }` form. A named `POLICY name { … }` block
  compiles but silently denies everything when passed with `--seccomp_string`.
- Kafel's aarch64 table lacks several syscalls Bun uses (`uname`, `fstat`, `sysinfo`,
  `close_range`, `epoll_pwait2`, `sched_setscheduler`, …). They are allowed through numeric
  aliases chosen per architecture in `src/sandbox/seccomp.ts`.
- A fresh procfs cannot be mounted inside locked container mounts (`mount('/proc')` gets
  `EPERM` and nsjail refuses when the outer `/proc` has masked paths). The jail uses
  `--disable_proc --tmpfsmount /proc`, which is also what makes `/proc` unreadable.
- The plugin UID must be mapped alongside UID 0 (`--user <id>:<id>:1 --user 0:0:1`) or
  nsjail cannot perform the mount setup after entering the user namespace. The process itself
  runs as the plugin UID (verified via `/proc/<pid>/status`).
- The broker socket is `0666` because the plugin runs as a different UID. It is only reachable
  through the jail's bind mount; per-plugin sockets and broker tokens are `plugin-platform`
  work.
