# plugin-host

The brokered plugin sandbox from [ADR 0009](../../docs/adr/0009-plugin-platform.md). The
isolation primitives were proven by spike S2 (`plugin-sandbox-spike`); this app is the
production runtime and its measured findings live in the ADR.

## What runs

- A Bun supervisor (`src/index.ts`) starts one demo plugin (`src/demo/plugin`) under nsjail.
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
  ready after that handshake and after verifying the cgroup limits it requested were applied.
- A handshake that announces a different plugin id is rejected, so a sandbox cannot claim
  another plugin's identity on the broker.

`GET /sandbox` returns the live status and the sandbox's cgroup values. Readiness includes
the sandbox, so `/health/ready` fails when nsjail cannot start. An unexpected exit, a failed
start or a supervisor-side wall-clock kill schedules an exponential restart
(`PLUGIN_HOST_RESTART_DELAY_MS`, `PLUGIN_HOST_RESTART_MAX_DELAY_MS`,
`PLUGIN_HOST_RESTART_MAX`); readiness is false while a restart is pending, and the status
reports the attempt count and `restartAt`.

## Lifecycle (task 4)

`packages/domain/src/plugins` owns the marketplace and lifecycle rules. The signed catalog is
verified with the development Ed25519 key, every package's SDK range is checked against the
installed SDK, and capability review lists elevated data access and egress hosts. Installs
require explicit approval plus step-up authentication within five minutes; the bundle checksum
and detached signature are verified before any row is written.

`PluginLifecycle` implements `installing → active → disabled → uninstalled` plus `upgrading`
and `failed`. Every step is journaled in `core.plugin_operations`; upgrades quiesce first, run
all migrations in one transaction, and restore the old version if migration fails. An
activation failure leaves the plugin failed/disabled and writes an admin-log entry. Disable
stops hooks/routes/jobs and bumps `pluginsGeneration`; uninstall can keep, erase or drop the
schema while the personal-data registry (`core.plugin_personal_data`) remains for GDPR.

`PluginCircuitBreaker` disables a plugin after 50 consecutive failures on the same hook and
queues a `plugin.auto_disabled` admin notification. Service principals default to Guests;
elevated forum grants write the warning key and an admin-log entry. GDPR requests use the
active sandbox or a maintenance sandbox and stay open when the handler fails.

The concrete nsjail/provisioning adapter is wired by the staff plugin integration (task 5.2);
the domain orchestrator is exercised with a failure-injecting runtime in the DB integration
suite.

## SDK, hooks and plugin apps

`packages/plugin-sdk` is the public, versioned plugin surface: manifest parsing, semver and
one-major shims, hook registration, a broker client/server, and the principal helper that
intersections capabilities × viewer × service principal. The same manifest parser validates
bundles at install time, so a bundle cannot describe hooks the host cannot install.

Core services call plugin-host's token-protected `/internal/*` API for view-model enrichers
(100 ms per plugin, declared fields/tags only), write filters and vetoes (300 ms shared budget,
fail-open/fail-closed), content extensions (output re-sanitised by the core), event and job
delivery, plugin routes, and bridge calls. Each plugin's events and jobs use their own pg-boss
queues (`plugin.<id>.events`, `plugin.<id>.<job>`).

Template fragments install into `core.hook_fragments` per `pluginsGeneration`, including
whole-template overrides; toggling or changing a bundle bumps the generation, which changes
the compile-cache and page variant keys. Plugin routes render under `/p/<plugin>/...` through
the theme, and API routes proxy under `/api/p/<plugin>/...`.

Client apps are served from the plugin origin (`plugins.<host>`) with a same-origin CSP for
its own assets and `connect-src 'none'`. The forum frame uses
`sandbox="allow-scripts allow-forms"` (never `allow-same-origin`). A per-iframe
`MessageChannel` plus random instance token carries resize/read/route/open/toast messages;
the host ignores `window` messages entirely, so another frame cannot spoof a call.

## Container contract and preflight (task 1.1)

ADR 0009 records the capabilities and seccomp profile nsjail needs. Before the broker starts,
`src/sandbox/preflight.ts` verifies the container matches that contract and refuses to run
plugin code otherwise, instead of degrading to weaker isolation:

- Linux, an executable `nsjail`, and the minimal root filesystem with `bin/bun`;
- the effective capability mask includes `CAP_SYS_ADMIN` (plus the engine defaults nsjail
  uses: `CAP_CHOWN`, `CAP_SETGID`, `CAP_SETUID`);
- the outer container seccomp mode is `0` (unconfined); Docker's default profile rejects
  `CLONE_NEWUSER`, while the jail's own Kafel filter remains the security boundary;
- a writable cgroup v2 root with the `memory`, `pids` and `cpu` controllers.

The preflight aggregates every problem and its compose fix into one log line
(`sandbox.preflight_failed`). After spawn, the supervisor reads `memory.max`, `pids.max` and
`cpu.max` from the sandbox cgroup and fails the sandbox (killing it) if any limit did not
stick, for example because an engine did not delegate a controller.

The seccomp policy stays a bare default-deny `ALLOW { … }` Kafel block. Newer mount-API,
cross-process inspection, keyring, io_uring and host-administration syscalls are on an
explicit forbidden list, and `forbiddenInAllowlist` makes the build fail if one is ever added
to the allowlist.

## Broker protocol and database (task 2.1)

The broker listens on the bind-mounted Unix socket and speaks **length-prefixed JSON-RPC 2.0**:
a 4-byte big-endian length followed by UTF-8 JSON, capped at 1 MiB per frame. The first message
is a `hello` notification; requests on one connection are handled in order. It currently
implements `db.query`, `http.fetch` and `log`.

```json
{"jsonrpc":"2.0","method":"hello","params":{"pluginId":"sandbox-demo","sdkVersion":"0.0.0"}}
{"jsonrpc":"2.0","id":1,"method":"db.query","params":{"sql":"SELECT body FROM notes","params":[]}}
```

### Database roles

At startup the broker provisions the ADR 0009 pair for the manifest id
(`sandbox-demo` → schema/role `plugin_sandbox_demo`, owner `plugin_sandbox_demo_owner`):

- `plugin_<id>_owner` is `NOLOGIN` and owns the schema, tables and functions. The plugin's
  `migrations` from `plugin.json` run in one transaction as this role, with `search_path` set
  to the plugin schema.
- `plugin_<id>` is `LOGIN`, `CONNECTION LIMIT 2`, `NOINHERIT`, with
  `statement_timeout=2s`, `idle_in_transaction_session_timeout=5s`, `work_mem=8MB` and
  `temp_file_limit=64MB`. It has `USAGE` on its schema and `SELECT/INSERT/UPDATE/DELETE` on
  its tables, `USAGE/SELECT` on its sequences and `EXECUTE` on its functions. It has no
  `CREATE`, no ownership and no privileges on `core`, `pii` or `public`.
- Default privileges for objects later created by the owner are granted to the runtime role.

The broker opens the runtime pool with `max: 2`, matching the role limit.

### Statement allowlist

`libpg-query` parses every `db.query` statement before it reaches Postgres:

- exactly one statement, and only `SELECT`, `INSERT`, `UPDATE` or `DELETE`;
- no DDL, `LISTEN`/`NOTIFY`, `SET`/`RESET`/`SET ROLE`, `COPY` (including `PROGRAM`), `DO`,
  `CALL`, `EXPLAIN`, `VACUUM`, `LOCK`, `MERGE`, `SELECT INTO` or row locking;
- table references are unqualified (resolved through the plugin's `search_path`) or use the
  plugin's own schema; `core`, `pii`, `public`, other plugins and cross-database names are
  rejected;
- function calls must be in a curated pure-builtin allowlist or defined in the plugin schema;
  `pg_sleep`, `set_config`, `pg_notify`, advisory locks, file/admin functions and `dblink`
  are rejected;
- data-modifying CTEs are rejected: PostgreSQL only allows them at the top level, and the
  result-row wrapper would move them into a subquery.

Postgres wraps `SELECT`s and DML with `RETURNING` in one query that measures `pg_column_size`
and returns either a small JSON envelope of the rows or a `broker_too_large` marker. The
server-side budget is 1000 rows / 256 KiB of expanded JSON; the broker also refuses a serialised result
over 512 KiB. A single huge value (`repeat('x', 100 MB)`) therefore never reaches plugin-host.
Rows are JSON-encoded at this boundary, so big integers arrive as JSON numbers; a typed cursor
for exact bigint fidelity is a `plugin-platform` follow-up. Database failures return a generic
error to the plugin; details go to the broker log, without the SQL text or parameters.

### SQL hardening and migrations (task 2.5)

Runtime statements are parsed with `libpg-query` and limited to DML on the plugin schema,
with the pure-builtin/plugin `FuncCall` allowlist. Deadlines are enforced from outside the
session: the broker reserves the connection, reads `pg_backend_pid()` and cancels the
statement from its control connection after the deadline (2 s by default), so a plugin cannot
extend it with `SET LOCAL`.

Migrations run as the dedicated `plugin_migrator` login (`NOINHERIT`, member of only this
plugin's owner), never from the admin or owner session. `src/broker/migration.ts` rejects
`SET`/`RESET`/`SET ROLE`, `DO`, `ALTER ROLE`/`ALTER SYSTEM`, extensions, `SECURITY DEFINER`,
non-transactional DDL and cross-schema objects before any migration runs. plpgsql bodies are
scanned for side-effecting built-ins and dynamic `EXECUTE`; SQL-standard bodies are parsed.
Core migration `0001` revokes `EXECUTE` from `PUBLIC` on side-effecting built-ins
(`set_config`, `pg_notify`, advisory locks, `pg_sleep`, `pg_terminate_backend`,
`pg_cancel_backend`, `dblob`/`dblink`, `lo_*` and file/admin functions) and grants them only
to the core roles, so a parser bypass still hits a database permission error.

### Connection budget (task 2.6)

Runtime role pools are opened lazily per plugin, closed after 10 s idle, and bounded by one
broker-wide semaphore (`PLUGIN_HOST` pool size, default 20 plugins). A plugin waiting for a
slot fails its own call after the deadline; other plugins keep working. `GET /broker`
reports `connections` (`open`, `waiting`, `opened`, `closed`, `rejections`).

### Request budgets and core forwarding

Each plugin has its own token bucket and concurrency gate: at most 2 concurrent database
statements and 20 statements/second, and 2 concurrent egress requests at 10/second. Waiting
for a database slot is bounded by the call deadline, so an exhausted budget denies only the
waiting plugin's call (`reason: "rate"` or `"concurrency"`, stats
`broker.stats().rateLimited/concurrencyLimited`).

`core.call` forwards SDK data APIs (`posts.get`, `members.get`, …) to
`PLUGIN_CORE_API_URL` (`http://user-api:3001`). The broker adds the trusted viewer context
(guest when the request did not come from a viewer) and a timestamped HMAC of the body signed
with `PLUGIN_CORE_BROKER_TOKEN`; the core API applies `can()` for that viewer. A plugin cannot
choose its own viewer: `core.call` params are passed through, but the viewer field is always
the broker's.

### Storage quota and shared-cluster warning

`src/quota/monitor.ts` measures each plugin schema every `PLUGIN_QUOTA_INTERVAL_MS`
(default 60 s) with `pg_total_relation_size`. Over `PLUGIN_STORAGE_QUOTA_MB` (default 1 GB)
it revokes `INSERT`/`UPDATE` on the schema's tables from the runtime role, which sticks
because the role is not the owner. Reads and `DELETE` keep working; writes stay off until an
admin calls `restoreWrites()` (wired to the plugin manager later). The plugin-host logs
`plugin.storage_quota_exceeded` and `GET /quota` reports the usage, quota and revocation
state.

In production, plugin schemas default to the core Postgres cluster. The host logs
`plugin.shared_cluster_warning` unless `PLUGIN_DATABASE_URL` points at a separate cluster;
`/quota` exposes the same `sharedCluster` flag for the staff warning.

### Egress (task 2.2)

`http.fetch` goes through `EgressProxy` (`src/broker/egress.ts`). The manifest's
`egressHosts` is an exact, lowercase allowlist; the demo declares `example.com`.

- Only `http`/`https`, ports 80/443, no URL credentials and no IP-address literals.
- Every hostname is resolved before each request; **all** answers must be public. Loopback,
  RFC 1918, CGNAT, link-local, metadata (`169.254.169.254`, `100.100.100.200`,
  `192.0.0.192`), multicast, documentation and reserved ranges are blocked, including
  IPv4-mapped (`::ffff:`) and NAT64 (`64:ff9b::`) forms.
- Redirects are followed manually (at most 5), and every hop is re-validated against the
  allowlist and the DNS rules. A redirect to a host outside the allowlist or to a private
  address is denied.
- `GET`, `POST` and `HEAD` only; request bodies are capped at 256 KiB, responses at 512 KiB.
  Hop-by-hop and `Host`/`Cookie` request headers are stripped, `Set-Cookie` is removed from
  responses, and `credentials: "omit"` is set.
- A denied request returns JSON-RPC `-32000` with a reason; network failures return `-32603`.
  The broker logs the host/reason, never resolved addresses.

The remaining DNS rebinding window (resolve, then let `fetch` resolve again) is recorded for
`plugin-platform`; pinning the checked address needs a custom fetch transport.

The demo plugin inserts into `plugin_sandbox_demo.notes`, reads it back and sends a `log`
request. `GET /broker` reports the schema and request/denial counters.

Caveats for `plugin-platform`: provisioning uses the local Postgres administrator (the real
installer uses `plugin_migrator`), role names/settings are cluster-wide, and statement
deadlines rely on the role's `statement_timeout` rather than cancellation from a control
connection.

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
docker compose logs plugin-host                 # sandbox.preflight_ok, sandbox.ready, plugin.database_ready
docker compose exec -T plugin-host bun -e \
  'console.log(await (await fetch("http://127.0.0.1:3004/sandbox")).text())'
docker compose exec -T plugin-host bun -e \
  'console.log(await (await fetch("http://127.0.0.1:3004/broker")).text())'
docker compose exec -T postgres psql -U bulletin -d bulletin \
  -c "select id, body from plugin_sandbox_demo.notes order by id desc limit 5"
```

## Measurement

The measurement script spawns and stops the demo sandbox N times. It runs one untimed warm-up
first so the shared Bun binary is already in the page cache; with a warm cache the per-sandbox
number is the marginal cost. It also asserts that the cgroup limits were applied.

```bash
docker compose exec -T -e PLUGIN_HOST_ENGINE=podman -e PLUGIN_HOST_MEASURE_ITERATIONS=10 \
  plugin-host bun apps/plugin-host/src/demo/measure.ts
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
- The **Docker engine was not available in the environment spike S2 ran in** (the host's
  `docker` is Podman). The script is engine-agnostic and detects `docker`/`libpod` from
  `/proc/self/cgroup`; the Docker row is produced by the E2E CI job, which runs this command
  on Docker and rootless Podman.

## Malicious-plugin suite

`src/malicious/malicious.test.ts` spawns a probe bundle (`src/malicious/plugin`) under nsjail
once per case. The probe reports through the broker; the tests assert denial/containment and
then start a benign demo sandbox to prove the supervisor and broker still work.

```bash
docker compose exec -T -e BULLETIN_SANDBOX_TESTS=1 plugin-host \
  bun test apps/plugin-host/src/malicious/malicious.test.ts
```

Cases: read `core`, read `pii`, runtime DDL, `LISTEN`, TCP connect, sibling bundle/host paths,
environment secrets, `/proc`, output flood, fork bomb, memory exhaustion, statement-rate abuse,
storage-quota abuse (writes revoked, reads kept) and egress SSRF variants (IP literals,
metadata/private DNS answers, rebinding, redirects, credentials). A wall-clock-kill case
proves the supervisor restarts the sandbox. The fork and memory cases use tighter limits
(`pids/nproc=32`, memory 128 MiB) and also verify the cgroup pids count. The iframe-bridge
escape case arrives with the client bridge (tasks 3.8/3.10), which owns the host page side.

The suite is skipped in the normal test image (no nsjail/capabilities). CI runs it on Docker
and rootless Podman after the E2E stack is healthy.

## nsjail / container caveats found

- nsjail 3.4 needs **CAP_SYS_ADMIN** and cgroupns=host to create one cgroup per sandbox.
- Rootful engines let the container write the host cgroup root. Rootless Podman mounts it
  read-only and puts the container under the user's systemd slice (or `libpod_parent` with
  the cgroupfs manager), so nsjail's cgroup parent must be a delegated ancestor.
  `src/sandbox/cgroup.ts` probes the mount and then every ancestor of the container's own
  cgroup, deepest first, and records which one it used.
- Docker's default seccomp profile blocks `clone`/`unshare` with `CLONE_NEWUSER`, so the
  container needs `seccomp=unconfined`. The jail's own filter is the security boundary.
- Bun's `Bun.spawn` helper uses `pidfd_open`. The profile allows it; omitting it kills the
  helper thread and leaves the plugin hung in `Bun.spawn` while the main process stays alive.
- The Kafel policy must be the bare `ALLOW { … }` form. A named `POLICY name { … }` block
  compiles but silently denies everything when passed with `--seccomp_string`.
- Kafel's aarch64 table lacks several syscalls Bun uses (`uname`, `fstat`, `sysinfo`,
  `close_range`, `epoll_pwait2`, `sched_setscheduler`, …). They are allowed through numeric
  aliases chosen per architecture in `src/sandbox/seccomp.ts`.
- A fresh procfs cannot be mounted inside locked container mounts (`mount('/proc')` gets
  `EPERM` and nsjail refuses when the outer `/proc` has masked paths). The jail uses
  `--disable_proc --tmpfsmount /proc`, which is also what makes `/proc` unreadable.
- Bun writes its runtime transpiler cache by default. Inside the jail that adds file syscalls
  outside the default-deny profile; the process died with a silent `SIGSYS` while executing a
  larger fixture. The jail sets `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`.
- At the cgroup pids limit, `Bun.spawn` can block instead of throwing in Bun 1.4.0. The
  sandbox is still contained: the malicious fork case verifies `pids.current <= pids.max` and
  the supervisor can start a benign sandbox after killing it.
- The plugin UID must be mapped alongside UID 0 (`--user <id>:<id>:1 --user 0:0:1`) or
  nsjail cannot perform the mount setup after entering the user namespace. The process itself
  runs as the plugin UID (verified via `/proc/<pid>/status`).
- The broker socket is `0666` because the plugin runs as a different UID. It is only reachable
  through the jail's bind mount; per-plugin sockets and broker tokens are `plugin-platform`
  work.
