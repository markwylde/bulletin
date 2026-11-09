# Design

## Context

ADR 0009 is the contract; this change starts with spike S2. If nsjail cannot run inside
rootless Podman with acceptable capabilities, the spike must produce a superseding ADR
(e.g. per-plugin containers) before task group 2 begins.

## Goals / Non-Goals

**Goals:** a secure, observable plugin runtime and SDK, proven by adversarial tests.

**Non-Goals:** a public marketplace web store (only the registry API and our mock); paid plugins.

## Decisions

- **Process model**: the plugin-host container runs a supervisor (Bun) and the broker. For
  each active plugin it spawns `nsjail` with:
  - `--user`/`--group` mapping to a per-plugin UID,
  - a read-only bind mount of the bundle and a tmpfs `/tmp`,
  - `--disable_clone_newnet=false` (a new empty netns) and the cgroup v2 limits,
  - `rlimit_nproc`, and seccomp (default deny for `ptrace`, `mount` and similar).

  The plugin process connects to a Unix socket bind-mounted into the jail.
- **Broker protocol**: length-prefixed JSON-RPC over the socket. Calls:
  - `db.query`, with the SQL statement-type allowlist enforced by `libpg_query` parsing
    (DML only, no session commands)
  - `core.*` (forwarded to user-api/staff-api internal endpoints with a signed broker token
    and the viewer context)
  - `http.fetch` (egress proxy)
  - `jobs.*`, `kv.*` (convenience over its schema)
  - `cache.invalidate(tags)` (namespaced `plugin:<id>:<tag>`, bumped by the broker's own core
    connection, coalesced at 50/s)
  - `log`
- **DB roles**: the installer creates `plugin_<id>_owner` and `plugin_<id>`. The broker
  connects as `plugin_<id>` using credentials it alone holds. Role settings:
  `statement_timeout`, `work_mem`, `temp_file_limit`, `idle_in_transaction_session_timeout`.
  `CONNECTION LIMIT 2`.
- **Hook dispatch**:
  - Template fragments are extracted from the bundle at install and stored as theme-layer
    templates keyed by plugin. The engine merges them at compile time per `pluginsGeneration`.
  - Enrichers and filters are RPCs from user-api to plugin-host with deadlines.
  - Event subscribers are pg-boss queues `plugin.<id>.events`, consumed by plugin-host and
    dispatched into the jail.
- **Client apps**: served from `plugins.<host>/<id>/<version>/…` with a CSP. They are framed
  with `sandbox="allow-scripts allow-forms"`. The bridge validates message schemas and origin,
  and rate-limits calls.
- **Signing**: Ed25519 over the bundle tarball. The catalog lists sha256. The dev key is used
  with `mocks/marketplace`.
- **Operations journal**: `plugin_operations(id, plugin, kind, step, state, error)` drives the
  resumable install/upgrade state machine.
- **Sample plugins**: `hide-post-count` (fragment override), `welcome-bot` (event + job +
  settings form + own table), `tip-jar` (iframe client app + forum action + route).

## Risks / Trade-offs

- [nsjail needs CAP_SYS_ADMIN inside the container] → the spike measures the exact capability
  set; plugin-host is the only privileged container, has no secrets except broker credentials,
  and is network-isolated from Postgres except through the broker's connection.
- [RPC latency on write filters] → a total 300 ms budget, and filters run only on writes.
- [SQL parser allowlist bypass] → defence in depth: DB grants enforce the same limits even if parsing is fooled.
