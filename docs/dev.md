# Local development

Bulletin starts with two steps (ADR 0002): clone the repository and run

```bash
docker compose up --watch
```

There is no `.env` file and no extra local setup. Open
`http://bulletin.localhost:8080`. The stack runs on Docker Engine with Compose v2 (≥ 2.24) or
Podman ≥ 5 with the Docker Compose v2 provider (`podman compose`). Infrastructure images are
intentionally not watched; application source is synced or restarted by Compose watch.

The root [README](../README.md) covers origins, mocks, the seed and the general test commands.
This guide covers the plugin sandbox in day-to-day development.

## The plugin sandbox

`plugin-host` is the service that runs untrusted plugin code under
[nsjail](adr/0009-plugin-platform.md). On `docker compose up --watch` it:

1. builds an Alpine 3.22 image with nsjail 3.4 and a minimal read-only root filesystem
   containing Bun 1.4.0 and its musl libraries;
2. discovers a writable cgroup v2 parent (the host root on rootful engines, the
   systemd-delegated `user.slice` on rootless Podman);
3. provisions the demo plugin's schema and roles (`plugin_sandbox_demo` and
   `plugin_sandbox_demo_owner`) and runs its migration from
   `apps/plugin-host/src/spike/plugin/migrations/`;
4. starts the broker's framed JSON-RPC socket and the database/egress broker;
5. spawns the demo plugin under nsjail and waits for its handshake. Readiness includes both
   the sandbox and the broker.

The service is the **only privileged container**. Its compose definition supplies the
minimum it needs:

```yaml
cap_add: [SYS_ADMIN]
security_opt: [seccomp=unconfined, label=disable]
cgroup: host
volumes: ["/sys/fs/cgroup:/sys/fs/cgroup:rw"]
```

The engine's default capabilities stay in place (nsjail needs `SETUID`/`SETGID`/`CHOWN` for
namespace and mount setup); `SYS_ADMIN` is the only addition. The outer seccomp profile must
be unconfined because Docker's default profile rejects `CLONE_NEWUSER`; the jail installs its
own default-deny filter. `label=disable` is for SELinux hosts. Do not remove these settings
or add them to other services.

The jail itself gets:

- its own UID (`sandboxUid(pluginId)`, 10 000–59 999) in fresh user, PID, mount, IPC, UTS,
  cgroup and network namespaces;
- a read-only bind of the plugin bundle at `/plugin`, a private tmpfs `/tmp`, an empty
  tmpfs over `/proc`, and `/dev/null`, `/dev/zero`, `/dev/urandom`;
- the broker Unix socket at `/run/broker.sock` — its only writable mount;
- cgroup v2 memory/pids/CPU limits, rlimits and a wall-clock watchdog;
- a default-deny seccomp profile. `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` is set because Bun's
  transpiler cache otherwise writes files using syscalls outside the profile.

The demo plugin inserts a row into `plugin_sandbox_demo.notes`, reads it back and sends a log
line through the broker. The schema is recreated/idempotently migrated on every start; its
rows are not part of the forum seed.

### Verify it is running

```bash
docker compose logs -f plugin-host
# look for: plugin.database_ready, broker.listening, sandbox.ready, plugin.log

docker compose exec -T plugin-host bun -e \
  'const r = await fetch("http://127.0.0.1:3004/health/ready"); console.log(r.status, await r.text())'
docker compose exec -T plugin-host bun -e \
  'console.log(await (await fetch("http://127.0.0.1:3004/sandbox")).text())'
docker compose exec -T plugin-host bun -e \
  'console.log(await (await fetch("http://127.0.0.1:3004/broker")).text())'

docker compose exec -T postgres psql -U bulletin -d bulletin \
  -c "select id, body from plugin_sandbox_demo.notes order by id desc limit 5"
```

`/sandbox` shows the sandbox state, startup time, memory and cgroup limits. `/broker` shows
the schema and query/egress/denial counters.

### Editing the plugin

`docker compose up --watch` syncs `apps/plugin-host/src` and `packages/` into the container.
A TypeScript change restarts Bun's watcher; the supervisor stops the old sandbox and starts a
new one. The bundle mount is read-only, so editing `apps/plugin-host/src/spike/plugin` is
picked up on the next restart. A change to `package.json`, `bun.lock` or the Dockerfile
triggers a Compose rebuild.

Bundle files must be world-readable (the image build normalises the demo and malicious
fixtures). Plugin installers must do the same when they write a bundle.

### Rootless Podman

Rootless Podman is supported without host changes. The container's `/sys/fs/cgroup` mount is
read-only at the host root, so the supervisor probes for the systemd-delegated parent
(`user.slice/...`) and points nsjail at it. If no writable cgroup parent with
`cpu`/`memory`/`pids` controllers exists, startup logs `sandbox.cgroup_unavailable`; the
plugin-host stays unready and the rest of the stack waits on it. Check
`docker compose logs plugin-host` and the container's cgroup v2 delegation. The per-plugin
container fallback is a production decision for `plugin-platform`, not a local workaround.

### Tests

- `bun run check` runs typecheck, lint and unit tests. Sandbox and database integration tests
  are skipped because they need nsjail/capabilities or `TEST_DATABASE_URL`.
- `docker compose -f compose.yaml -f compose.test.yaml --profile test run --rm test` runs the
  full test service against Postgres (the template database is cloned per test file).
- The malicious-plugin suite needs the running stack because it spawns real jails:

  ```bash
  docker compose exec -T -e BULLETIN_SANDBOX_TESTS=1 plugin-host \
    bun test apps/plugin-host/src/malicious/malicious.test.ts
  ```

  It covers core/pii reads, runtime DDL, `LISTEN`, TCP sockets, sibling bundles, environment
  secrets, `/proc`, a fork bomb and memory exhaustion, and starts a benign sandbox after each
  containment check.
- The sandbox measurement is documented in
  [`apps/plugin-host/README.md`](../apps/plugin-host/README.md):

  ```bash
  docker compose exec -T -e PLUGIN_HOST_ENGINE=podman \
    -e PLUGIN_HOST_MEASURE_ITERATIONS=10 plugin-host \
    bun apps/plugin-host/src/spike/measure.ts
  ```

Stop the stack with `docker compose down` (data kept) or reset everything, including the
plugin schema and roles, with `docker compose down -v`.

### Troubleshooting

- **`/health/ready` reports `sandbox: false` / `broker: false`** — read
  `docker compose logs plugin-host`. The supervisor logs the nsjail stderr and the sandbox
  error; `/sandbox` shows the last state. The stack's proxy depends on a healthy plugin-host,
  so this blocks the other origins until fixed.
- **`sandbox.cgroup_unavailable`** — the container cannot create a child cgroup. Check that
  the engine uses cgroup v2 and that the compose `cgroup: host`/`/sys/fs/cgroup` mount is
  intact. Rootless hosts need a delegated systemd user slice.
- **nsjail/namespace errors** — the plugin-host container must have `SYS_ADMIN`, an
  unconfined outer seccomp profile and `label=disable` on SELinux hosts; use the compose
  service as-is.
- **The demo inserts no row** — check the `plugin.log` line and the broker counters; a
  migration or role error is logged at startup (`plugin.database_ready` is the success line).
- **A full reset** — `docker compose down -v` removes the Postgres and darkauth-mock volumes;
  the plugin schema/roles and forum seed are recreated on the next start.
