# 0009 — Plugin platform

**Status:** Accepted (spike S2 findings recorded below; revised after review)

## Context
Admins install plugins from **our marketplace** at runtime, with no rebuild. Plugins are
**untrusted third-party code**: powerful, but unable to read or corrupt core data, act as a
member, or take the board down.

## Decision
### Packaging and install
- A plugin is a signed bundle containing:
  - `plugin.json` manifest: id, version, SDK range, requested capabilities, hooks, settings
    schema, routes, jobs, migrations, i18n catalogs, template fragments, client apps, egress hosts
  - a server entry
  - assets
- The marketplace (`mocks/marketplace` locally) serves bundles. Install flow in the staff app:
  review capabilities → approve → verify signature and checksum → store in S3 → run migrations
  → start the sandbox → bump `pluginsGeneration`.
- **Lifecycle states**: `installing → active → disabled → uninstalled`, plus `failed`.
- **Upgrades: old code never runs against a new schema.** The steps are recorded in
  `core.plugin_operations`, so a crash resumes from the last completed step.
  1. **Quiesce**: the state becomes `upgrading`. Its hooks are skipped (as if disabled), its
     routes return 503, the broker stops dispatching its jobs and events (they stay queued),
     and the old sandbox stops after in-flight calls finish (≤ 10 s, then killed).
  2. **Migrate**: all pending migrations run in **one transaction**. Non-transactional
     statements are rejected at bundle validation. On failure, everything rolls back, the old
     sandbox restarts and the state returns to `active` at the old version.
  3. **Activate**: the new sandbox starts and must pass a health check. On success, the
     state becomes `active`, `pluginsGeneration` bumps and queues resume. On failure, the
     state becomes `failed` (behaves as disabled) at the new schema. The admin can retry or
     uninstall. The old code is not restarted.
  - Downgrades are not supported. Restoring a previous version means uninstall plus a data
    export/import that the plugin provides.

### Server isolation: brokered sandbox
- `plugin-host` is a supervisor container. Each plugin runs as a Bun process inside **its
  own sandbox** (nsjail), with:
  - its own UID and a read-only root, seeing only its own bundle directory plus a private tmpfs,
  - **no network namespace access**: its only channel is a Unix socket to the **broker**,
  - cgroup CPU, memory and pids limits, plus a wall-clock watchdog that kills it,
  - no environment secrets. Its broker token is passed over the socket at start.
- **Everything goes through the broker**, which enforces the plugin's approved capabilities:
  - **DB roles**: two roles per plugin.
    - `plugin_<id>_owner` (NOLOGIN) owns schema `plugin_<id>` and every object in it. It is
      used **only by the installer during migrations**.
    - `plugin_<id>` is the runtime role. It has **DML only** (SELECT/INSERT/UPDATE/DELETE on
      the schema's tables, USAGE on its sequences): no CREATE, no ownership, and no grant
      option, so it cannot create objects or regrant privileges. DDL exists only in migrations.
  - **Migrations** run over a dedicated login role `plugin_migrator` (`NOINHERIT`, member of
    each `plugin_<id>_owner` only, nothing else), never from an owner or superuser session, so
    `RESET ROLE` gains nothing. Migration SQL is parsed with `libpg-query` and rejects `SET`,
    `RESET`, `SET ROLE`, `DO` blocks, `SECURITY DEFINER`, `ALTER ROLE`, `GRANT` outside the
    schema, and calls to functions outside the allowlist.
  - **Function calls**: migration `0001` revokes `EXECUTE` from `PUBLIC` on side-effecting
    built-ins (`set_config`, `pg_notify`, advisory-lock functions, `pg_sleep`,
    `pg_terminate_backend`, `pg_cancel_backend`, `dblink*`, `lo_*`, file and admin functions)
    and grants them only to the core roles that need them. The broker also rejects any
    `FuncCall` outside an allowlist of pure built-ins plus the plugin's own schema functions,
    and plugin functions are validated by the same rules at migration.
  - **Deadlines are enforced outside the session**: the broker cancels any statement past its
    deadline from its own control connection, so changing settings inside the session cannot
    extend it.
  - **Runtime role limits**: no access to `core`, `pii`, `pgboss`, `public` or other plugins;
    `CONNECTION LIMIT 2`; `statement_timeout 2s`; `idle_in_transaction_session_timeout 5s`;
    temp table quota. The broker rejects `LISTEN`, `NOTIFY`, `COPY … PROGRAM`, `SET ROLE`
    and other session-level commands.
  - **DB resource budgets** (Postgres work isn't bounded by process cgroups, so the broker
    and database enforce them):
    - the role has `work_mem`, `temp_file_limit` and `statement_timeout` set, plus
      `maintenance_work_mem` caps,
    - the broker limits each plugin to 2 concurrent statements and a statements/second rate,
    - **storage quota**: Postgres has no hard per-schema quota, so growth is bounded rather than
      prevented:
      - Only DML can allocate space at runtime, because the runtime role cannot CREATE.
      - The broker caps statements per second, and `statement_timeout` caps work per statement.
      - A worker measures the schema size every 60 s. Over quota (default 1 GB), it revokes
        INSERT/UPDATE from the runtime role, which sticks because the role isn't the owner, and
        alerts admins.
      - The maximum overshoot is therefore one minute of rate-limited writes.
      - **Hard isolation** of core availability needs a separate plugin cluster (below).
        The staff app shows a warning when untrusted plugins share the core cluster in production.
    - `CREATE EXTENSION`, untrusted languages, `CREATE FUNCTION … SECURITY DEFINER`, and
      triggers on anything outside its schema are disallowed (`plpgsql` only),
    - production may point all plugin schemas at a **separate Postgres cluster**
      (`PLUGIN_DATABASE_URL`) to fully isolate core availability. Locally they share the one
      Postgres (ADR 0003).
  - **Core data**: SDK calls (`posts.get`, `members.addBadge`…) go via the broker to the core APIs.
    - **In a viewer context** (enrichers, template-hook data, plugin routes serving a request,
      iframe bridge calls), the effective principal is **plugin capabilities ∩ current
      viewer's permissions ∩ the plugin's service-principal access**. A plugin therefore can
      never read through a privileged viewer anything its service principal couldn't read, so
      it cannot copy staff-only content into its schema and later show it to guests. The broker attaches the viewer context, and core APIs check
      `can()` as the viewer. The visibility bits used are added to the fragment's deps
      (ADR 0005), so a privileged plugin can never expose to a viewer anything the viewer
      couldn't read.
    - **In a background context** (event subscribers, jobs), calls use the plugin's
      **service principal**, a service member in normal groups plus capability scopes.
    - **Confidentiality contract**: a plugin can store anything its service principal reads,
      in its schema or memory, and may later show it to any viewer. Enforcing per-datum
      provenance inside arbitrary plugin code is infeasible, so we bound the risk instead:
      - **A plugin's service principal defaults to the Guests group**, so background access is
        public content only.
      - Granting a plugin access beyond Guests is an explicit admin step at install or later.
        It uses a red warning naming the forums: "this plugin can read X and may display or
        repost it to anyone".
      - The guarantee is therefore: **a plugin can only disclose what an admin explicitly let
        its service principal read.** Viewer-context intersection still prevents a plugin from
        using a privileged viewer's request to read more.
    - PII requires an explicit audited capability (ADR 0012).
  - **HTTP egress**: through the broker's proxy, allowed only to manifest-declared hosts, with
    SSRF rules.
  - **Jobs**: the broker enqueues and schedules into `plugin.<id>.*` pg-boss queues on the
    plugin's behalf. Plugins never touch the pgboss schema.
- In production the same model applies. On hosts where nsjail is unavailable, each plugin
  runs in its own container with an equivalent network policy (defined in spike S2).

### Client-side isolation
- Plugins **never run JavaScript in the forum origin**.
- **Plugin client apps** are served from the plugin origin (`plugins.<host>`, ADR 0018) in
  `<iframe sandbox="allow-scripts allow-forms">`, without `allow-same-origin`, so they have no
  forum cookies and no ambient credentials.
- They talk to the page through a **postMessage bridge**. Sandboxed frames have an opaque
  `"null"` origin, so origin checks cannot identify them. Instead the host creates a
  `MessageChannel` per iframe and transfers one port to that frame's `contentWindow` after
  load, together with a random per-instance token. Only messages on that port with that token
  are accepted, and each port is bound to one plugin instance; `window` messages are ignored. The bridge has a small validated API
  (resize, read the view-model fields the hook was given, call the plugin's own server routes
  via the broker, open a link, show a toast). Any data from the bridge is scoped to what the
  hook already rendered.
- **Template fragments** (static Liquid) are allowed in the forum origin, under the theme
  security rules in ADR 0008.

### Hook types (versioned in `packages/plugin-sdk`)
| Type | Runs | Failure mode |
|---|---|---|
| Template fragment / override | compile time, no per-request RPC | invalid fragment rejected at install |
| View-model enricher | fragment build, cached with declared tags | timeout 100 ms → field omitted |
| Filter (transform) | write path, sequential by priority | timeout → skip (fail-open) |
| Veto filter (needs `veto:<hook>`) | write path | per plugin, admin-chosen: fail-open (default) or fail-closed |
| Event subscriber | async via pg-boss | retries → dead letter |
| Content extension | write-time render, output re-sanitised | error → raw markdown kept |
| Routes | `/p/<plugin>/…` (themed), `/api/p/<plugin>/…` | 5xx contained, circuit breaker |
| Jobs | plugin queues | retries → dead letter |
| Permissions / settings | registry entries in the plugin namespace | — |

- **Write-path budget**: all plugin filters on one write share a **300 ms total** budget.
  Hooks not reached in time are skipped (or fail-closed vetoes reject with a clear error).
- **Events**: each subscribing plugin gets its own delivery record and queue (ADR 0011). One
  plugin cannot ack another plugin's events.

### Plugin cache invalidation
- Plugins cannot write `core.cache_tags` or `NOTIFY`. The broker exposes
  `cache.invalidate(tags[])`, which bumps tags in the plugin's own namespace only
  (`plugin:<id>:<tag>`) and sends the NOTIFY on the plugin's behalf.
- Enrichers and plugin route fragments declare dependencies on these namespaced tags. The core
  adds them to the fragment's tag set alongside the core tags.
- When called inside a broker DB transaction, the bump commits with that transaction.
  Otherwise it is immediate. Calls are rate-limited per plugin (default 50/s), and excess
  calls collapse into one bump.

### Personal data in plugin schemas
- The manifest declares which tables hold personal data and how they map to member IDs. The
  core keeps this registry even when a plugin is disabled, failed or uninstalled with data kept.
- Export and erasure call `gdpr.export` / `gdpr.erase` on active plugins. For a plugin that is
  not running, the worker starts it in a **maintenance sandbox** (no hooks, routes or
  egress; only its GDPR handlers). If that fails, the data request stays open and staff are
  alerted; it cannot complete while retained plugin data is unprocessed.

### Disable and uninstall semantics
- **Disable** takes effect on the next request:
  - it bumps `pluginsGeneration`, so templates recompile without the plugin's fragments and
    all cached enrichments and fragments miss,
  - its routes return 404, iframes disappear with the fragments, the sandbox stops, and queued
    jobs pause,
  - **write-time rendered content keeps its sanitised HTML.** A "re-render affected content"
    action is offered.
- **Uninstall**: disable, then optionally drop `plugin_<id>` (with GDPR export/erase hooks run
  first, ADR 0012) and remove its settings and flags.

### Staff app extension (locked down)
- Plugins **cannot ship staff-app UI code**. They declare settings with a JSON-schema-based
  **form builder DSL** (fields, sections, validation, conditional visibility, i18n labels),
  rendered by core components.
- Plugins can add sections to existing settings pages through declared extension points
  (e.g. `acp.groups.settings`, `acp.forums.edit`).
- Plugins can add ACP pages only from fixed page types: settings form, data table, and log viewer.

### Reliability
- A circuit breaker per plugin auto-disables it after repeated failures and notifies admins.
- Health, timings and logs are visible in the staff app.
- The SDK is semver'd, with compatibility shims for one major version.

### Spike S2 findings (plugin-sandbox-spike)
Ran as change `plugin-sandbox-spike`, straight after the foundation. Outcome: the brokered
nsjail model is **accepted**; no superseding ADR is needed. The prototype is in
`apps/plugin-host`; `plugin-platform` hardens it. Raw measurements, reproduction commands and
the day-to-day notes are in `apps/plugin-host/README.md` and `docs/dev.md`.

**Engines.** Verified end-to-end on rootful Podman 6.1.4 and rootless Podman 6.1.4 (Linux
7.2.7, cgroup v2, aarch64) with Bun 1.4.0 and nsjail 3.4: sandbox spawn and handshake, broker
DB roles and statement allowlist, egress proxy, and the malicious-plugin suite. The local
environment had no Docker Engine (its `docker` CLI points at Podman); the CI E2E matrix runs
the same compose contract and malicious suite on Docker and on rootless Podman.

**Required container capabilities.** Only the plugin-host container is privileged:
- Engine default capabilities stay in place, plus `SYS_ADMIN`. Dropping everything and
  re-adding a smaller set breaks nsjail's namespace and mount setup in this image.
- `seccomp=unconfined` on the outer container: Docker's default profile rejects
  `CLONE_NEWUSER`. The jail installs its own filter, which is the security boundary.
  `label=disable` is needed on SELinux hosts.
- `cgroup: host` and a writable `/sys/fs/cgroup`. Rootful engines can write the host cgroup
  root; rootless Podman needs the systemd-delegated `user.slice` parent, discovered at
  startup. No per-plugin container fallback was needed on either tested engine.
- nsjail maps the per-plugin UID and also maps UID 0 for its own mount/cgroup setup; the
  plugin process runs as the per-plugin UID (verified via `/proc/<pid>/status`).

**Seccomp profile.** `apps/plugin-host/src/sandbox/seccomp.ts` builds a default-deny Kafel
policy passed with `--seccomp_string`:
- It must be the bare `ALLOW { … }` form; a named `POLICY` block compiles but is ignored by
  nsjail 3.4, denying everything.
- The allowlist covers the syscalls a broker-connected Bun needs. Kafel's aarch64 table lacks
  some (`uname`, `fstat`, `sysinfo`, `close_range`, `epoll_pwait2`, `sched_setscheduler`,
  …), so they are added through numeric aliases chosen per architecture.
- Denied: `ptrace`, `mount`/`unshare`/`setns`/`pivot_root`/`chroot`, module, BPF, kexec,
  perf, keyring and handle syscalls, `userfaultfd`, `setuid`/`setgid`/`capset`, reboot, swap,
  syslog and other host-administration calls.
- `socket` stays allowed for the broker's AF_UNIX socket; the empty network namespace is the
  network boundary. `pidfd_open` is allowed because Bun's process-spawn helper uses it;
  omitting it kills that helper thread and leaves `Bun.spawn` hanging.
- The jail sets `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`: Bun's transpiler cache otherwise adds
  file syscalls outside the profile, killing the plugin with a silent `SIGSYS`.

**Measured overhead.** Default limits: 256 MiB, 64 pids, 500 ms CPU per second.

| Metric | Rootful Podman | Rootless Podman |
|---|---|---|
| Spawn → handshake | median 20 ms, mean 22 ms, p95 31 ms | median 25 ms, mean 25 ms, p95 33 ms |
| Sandbox `memory.current`, warm | mean 3.6 MiB | mean 3.5 MiB |
| Anonymous memory, warm | mean 3.0 MiB | mean 3.0 MiB |

A cold first sandbox is ~20 MiB; ~17 MiB of that is shared Bun/loader page cache. The nsjail
process tree's RSS over-counts shared pages (~38 MiB) and is only a cross-check.

**Broker and egress evidence.** Framed JSON-RPC, the `plugin_<id>` / `plugin_<id>_owner`
roles, role settings, the DML-only AST allowlist (own schema, pure/plugin functions, result
caps), and the egress host allowlist/private-address/redirect rules are covered by unit tests
and real-Postgres integration tests. The malicious suite proves core/pii reads, runtime DDL,
`LISTEN`, TCP connect, sibling/host reads, environment secrets and `/proc` are denied; an
output flood, a fork bomb and memory exhaustion are contained and the supervisor can start a
benign sandbox afterwards.

**Container caveat.** A fresh procfs cannot be mounted under locked container mounts, so the
jail uses `--disable_proc --tmpfsmount /proc`; this also makes `/proc` unreadable. The broker
socket is a shared 0666 socket in the spike; per-plugin sockets and broker tokens belong to
`plugin-platform`.

**Follow-ups owned by `plugin-platform`** (no `docs/roadmap.md` scope change):
- Out-of-session statement deadline cancellation; the spike relies on the role's
  `statement_timeout = '2s'` (`plugin-platform` task 2.5).
- Primary DNS pinning for egress: every resolved address is checked, but `fetch` resolves
  again, leaving a rebinding window (`plugin-platform` task 2.4).
- Installer credentials (`plugin_migrator`) instead of the local administrator, per-install
  role credentials, per-plugin sockets/tokens, the supervisor pool/restart/backoff, and
  cluster-wide vs per-database role settings.
- Iframe bridge escape is not covered here because client apps are a non-goal of this spike;
  it belongs to `plugin-platform` tasks 2.4/3.10.
- At the pids limit, Bun 1.4.0 `Bun.spawn` can block instead of throwing. The cgroup contains
  it (`pids.current <= pids.max`) and the supervisor kills the sandbox, but supervisor
  hardening must treat a blocked plugin as unhealthy.

## Consequences
- The plugin-host, broker and SDK are first-class products.
- The seed installs at least three sample plugins: one template hook + iframe app, one event +
  job, one settings form + own schema.
