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
This guide covers the themed routes and the plugin sandbox in day-to-day development.

## Themed routes

Every user-app page renders through the default theme (ADR [0008](adr/0008-themes-and-templates.md)):
Astro supplies the shell, the DB-stored Liquid templates supply the body, and React islands
hydrate in the browser.

- `http://bulletin.localhost:8080/_demo/1` — the demo route over the fixture forum tree. `1` is
  a category, `2` a forum with topics, `3` the password-protected forum (development password
  `demo-password`, also shown on the locked page), `4` an empty forum and `6` onwards forums the
  visitor may not see. Log in as `forum-mod` or `super-mod` to see the moderator tools, or use
  `?deleted=1` as a moderator to reveal the deleted fixture topic.
- `http://bulletin.localhost:8080/display-name` — the step page for a member without a name; the
  `step-member` profile starts without one.
- `http://bulletin.localhost:8080/account` — display name and history, active sessions and the
  language setting.

The demo route renders through the in-process cache (`packages/cache`): the variant key covers
the forum id, capability answers, theme version, plugin generation, locale, colour scheme and
render-flag hash, and `forum:<id>` is its only invalidation tag. `tests/integration/demo-cache-variants.test.ts`
registers it with the reusable variant harness, which covers permission, unlock, moderator, flag
and plugin-generation variants and fails on leaked content.

The demo route returns the themed 404 outside development and for unknown ids. Theme sources
live in [`packages/templates/themes/default`](../packages/templates/themes/default); the seed
installs them into `core.themes`/`core.theme_templates` (task 8.2 verifies the repo-to-DB sync).
Pull a new seed change with `docker compose down -v` before starting again.

## The plugin sandbox

`plugin-host` is the service that runs untrusted plugin code under
[nsjail](adr/0009-plugin-platform.md). On `docker compose up --watch` it:

1. builds an Alpine 3.22 image with nsjail 3.4 and a minimal read-only root filesystem
   containing Bun 1.4.0 and its musl libraries;
2. runs the container preflight (Linux, nsjail, root filesystem, `CAP_SYS_ADMIN` and the
   engine's default capabilities, an unconfined outer seccomp profile) and discovers a
   writable cgroup v2 parent (the host root on rootful engines, the deepest delegated
   ancestor such as `user.slice` on rootless Podman);
3. provisions the demo plugin's schema and roles (`plugin_sandbox_demo` and
   `plugin_sandbox_demo_owner`) and runs its migration from
   `apps/plugin-host/src/demo/plugin/migrations/`;
4. starts the broker's framed JSON-RPC socket and the database/egress broker;
5. spawns the demo plugin under nsjail and waits for its handshake and for the requested
   cgroup limits to read back correctly. Readiness includes both the sandbox and the broker.
   An unexpected exit or failed start restarts it with exponential backoff (capped by
   `PLUGIN_HOST_RESTART_MAX`); `/sandbox` shows the restart count and `restartAt`.

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
# look for: sandbox.preflight_ok, plugin.database_ready, broker.listening,
#          sandbox.ready, plugin.log

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
new one. The bundle mount is read-only, so editing `apps/plugin-host/src/demo/plugin` is
picked up on the next restart. A change to `package.json`, `bun.lock` or the Dockerfile
triggers a Compose rebuild.

Bundle files must be world-readable (the image build normalises the demo and malicious
fixtures). Plugin installers must do the same when they write a bundle.

### Rootless Podman

Rootless Podman is supported without host changes. The container's `/sys/fs/cgroup` mount is
read-only at the host root, so the supervisor probes the container's cgroup ancestors
(deepest first) for a writable parent with the `cpu`/`memory`/`pids` controllers, such as
the systemd-delegated `user.slice/...` or `libpod_parent`, and points nsjail at it. If the
preflight finds no usable parent — or the container is missing `SYS_ADMIN` or the
unconfined outer seccomp profile — startup logs `sandbox.preflight_failed` with the fix,
and the plugin-host exits instead of running plugins with weaker isolation. Check
`docker compose logs plugin-host` and the container's cgroup v2 delegation. There is no
per-plugin container fallback locally.

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
  secrets, `/proc`, an output flood, a fork bomb and memory exhaustion, and starts a benign
  sandbox after each containment check.
- The sandbox measurement is documented in
  [`apps/plugin-host/README.md`](../apps/plugin-host/README.md):

  ```bash
  docker compose exec -T -e PLUGIN_HOST_ENGINE=podman \
    -e PLUGIN_HOST_MEASURE_ITERATIONS=10 plugin-host \
    bun apps/plugin-host/src/demo/measure.ts
  ```

Stop the stack with `docker compose down` (data kept) or reset everything, including the
plugin schema and roles, with `docker compose down -v`.

### Troubleshooting

- **`/health/ready` reports `sandbox: false` / `broker: false`** — read
  `docker compose logs plugin-host`. The supervisor logs the nsjail stderr and the sandbox
  error; `/sandbox` shows the last state. The stack's proxy depends on a healthy plugin-host,
  so this blocks the other origins until fixed.
- **`sandbox.preflight_failed`** — the one-line error names each problem: a missing
  capability (`cap_add: [SYS_ADMIN]`), a filtered outer seccomp profile
  (`seccomp=unconfined`), a missing nsjail/root filesystem, or no writable cgroup v2 parent.
  Check the engine uses cgroup v2 and that the compose `cgroup: host`/`/sys/fs/cgroup` mount
  is intact; rootless hosts need a delegated systemd user slice.
- **`sandbox.limits_not_applied`** — nsjail started but the cgroup limits read back
  differently (usually an undelegated controller). The supervisor kills the sandbox and
  readiness fails; fix the delegation rather than relaxing the limits.
- **nsjail/namespace errors** — the plugin-host container must have `SYS_ADMIN`, an
  unconfined outer seccomp profile and `label=disable` on SELinux hosts; use the compose
  service as-is.
- **The demo inserts no row** — check the `plugin.log` line and the broker counters; a
  migration or role error is logged at startup (`plugin.database_ready` is the success line).
- **A full reset** — `docker compose down -v` removes the Postgres and darkauth-mock volumes;
  the plugin schema/roles and forum seed are recreated on the next start.
