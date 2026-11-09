# 0009 — Plugin platform

**Status:** Accepted, pending spike S2 (revised after review)

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
  Upgrades run migrations in the plugin's schema; on failure the plugin stays disabled at the
  old version, with no partial activation.

### Server isolation: brokered sandbox
- `plugin-host` is a supervisor container. Each plugin runs as a Bun process inside **its
  own sandbox** (nsjail), with:
  - its own UID and a read-only root, seeing only its own bundle directory plus a private tmpfs,
  - **no network namespace access**: its only channel is a Unix socket to the **broker**,
  - cgroup CPU, memory and pids limits, plus a wall-clock watchdog that kills it,
  - no environment secrets. Its broker token is passed over the socket at start.
- **Everything goes through the broker**, which enforces the plugin's approved capabilities:
  - **DB**: SQL runs as role `plugin_<id>` with: USAGE/CREATE only on schema `plugin_<id>`;
    no access to `core`, `pii`, `pgboss`, `public` or other plugins;
    `CONNECTION LIMIT 2`; `statement_timeout 2s`; `idle_in_transaction_session_timeout 5s`;
    temp table quota. The broker rejects `LISTEN`, `NOTIFY`, `COPY … PROGRAM`, `SET ROLE`
    and other session-level commands.
  - **Core data**: SDK calls (`posts.get`, `members.addBadge`…) go via the broker to the core
    APIs as the plugin's **service principal**. That principal is checked with `can()` plus
    capability scopes. PII requires an explicit audited capability (ADR 0012).
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
- They talk to the page through a **postMessage bridge**. The bridge has a small validated API
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

### Spike S2 (before feature work)
Prove the nsjail sandbox inside rootless Podman and Docker: the broker socket, DB role
restrictions and egress proxy. Include a **malicious-plugin test suite**: read `core`/`pii`,
`LISTEN`, open sockets, fork-bomb, exhaust memory, read sibling bundles, read env and
`/proc`, and escape via the iframe bridge. Record required container capabilities here.

## Consequences
- The plugin-host, broker and SDK are first-class products.
- The seed installs at least three sample plugins: one template hook + iframe app, one event +
  job, one settings form + own schema.
