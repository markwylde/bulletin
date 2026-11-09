# Proposal

## Why

ADR 0009 rests on an unproven assumption: that nsjail can isolate untrusted Bun plugin
processes inside both Docker and rootless Podman, with a broker as the only channel out.
Spike S2 must settle this before any feature work that depends on the plugin model
(`themes` hook points, `plugin-platform`, plugin GDPR hooks). Doing it early means a failure
costs one superseding ADR, not a rewrite.

## What Changes

- A time-boxed (3 day) prototype of `apps/plugin-host`: supervisor, one nsjail-sandboxed Bun process, and a broker on a Unix socket.
- Broker DB path with the `plugin_<id>` (DML only) and `plugin_<id>_owner` roles, the statement allowlist and the role limits from ADR 0009.
- Egress proxy with a manifest host allowlist and SSRF rules.
- The first malicious-plugin cases, kept as the seed of the CI suite that `plugin-platform` completes.
- ADR 0009 updated with the findings, required container capabilities and status, or a superseding ADR.

## Capabilities

### New Capabilities
- None. This is a spike (`skip_specs`); behaviour is specified in `plugin-platform`.

### Modified Capabilities
- None.

## Impact

- `apps/plugin-host` (prototype, kept as the starting point for `plugin-platform`), `docker-compose.yml` (plugin-host service and its capabilities), CI (Docker and Podman jobs), ADR 0009.
