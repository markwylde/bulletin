# Design

## Context

ADR 0009 is the contract this spike tests. It depends only on `foundation-dev-environment`
(compose, Postgres, CI). If the sandbox cannot run under rootless Podman with acceptable
capabilities, stop and write a superseding ADR (e.g. one container per plugin with an
equivalent network policy) before `plugin-platform` is planned in detail.

## Goals / Non-Goals

**Goals:** a yes/no answer, with evidence, on nsjail inside Docker and rootless Podman; the
broker DB path proven against hostile SQL; the required container capabilities recorded.

**Non-Goals:** the SDK, hook types, lifecycle, marketplace, staff screens and iframe client
apps (all `plugin-platform`).

## Decisions

- **Process model**: plugin-host runs a Bun supervisor and broker. Each plugin is spawned by
  `nsjail` with a per-plugin UID mapping, a read-only bind mount of its bundle, a tmpfs
  `/tmp`, a new empty network namespace, cgroup v2 CPU/memory/pids limits, `rlimit_nproc` and
  a default-deny seccomp policy for `ptrace`, `mount` and similar. The only channel is a Unix
  socket bind-mounted into the jail.
- **Broker protocol**: length-prefixed JSON-RPC. The spike implements `db.query`,
  `http.fetch` and `log` only.
- **DB**: the installer runs a test migration as `plugin_x_owner`; the runtime connects as
  `plugin_x` with `CONNECTION LIMIT 2`, `statement_timeout 2s` and
  `idle_in_transaction_session_timeout 5s`. The broker rejects `LISTEN`, `NOTIFY`,
  `COPY … PROGRAM`, `SET ROLE` and DDL before they reach Postgres.
- **Malicious cases in scope**: read `core` and `pii`; DDL at runtime; `LISTEN`; open a TCP
  socket; fork bomb; memory exhaustion; read a sibling bundle; read the environment and
  `/proc`. Each case asserts the action fails and the supervisor and broker stay healthy.
- **Output**: a findings section in ADR 0009 (container capabilities, seccomp profile,
  measured spawn time and memory overhead, Podman caveats) and its status set to Accepted,
  or a superseding ADR.

## Risks / Trade-offs

- [Rootless Podman lacks the user namespace or cgroup delegation nsjail needs] → the spike's
  fallback is per-plugin containers; that is the superseding-ADR path, not a workaround.
- [Prototype code drifting into production] → kept in `apps/plugin-host` but marked as a
  spike; `plugin-platform` task 1 reviews and hardens it.

## PII checklist (ADR 0012)

Not applicable: the spike handles no personal data. The malicious suite only proves that
`pii` is unreachable.
