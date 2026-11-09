# Tasks

## 1. Sandbox

- [x] 1.1 Add the plugin-host service to compose with the minimum capabilities, and prototype the supervisor spawning one Bun plugin under nsjail (UID mapping, empty netns, cgroup limits, seccomp, Unix socket) on Docker and rootless Podman
- [x] 1.2 Measure spawn time and memory overhead per sandbox on both engines, and record them

## 2. Broker

- [x] 2.1 Prototype the broker JSON-RPC (`db.query`, `http.fetch`, `log`) with the `plugin_x` and `plugin_x_owner` roles, role limits and the statement allowlist
- [x] 2.2 Prototype the egress proxy with a host allowlist and SSRF rules (private ranges, metadata IPs, redirects to disallowed hosts)

## 3. Malicious cases

- [ ] 3.1 Write the malicious-plugin cases (read `core`/`pii`, runtime DDL, `LISTEN`, TCP socket, fork bomb, memory exhaustion, sibling bundle, env and `/proc`) as `bun test` integration tests that assert denial and a healthy supervisor
- [ ] 3.2 Run the cases in CI on Docker and rootless Podman

## 4. Decision

- [ ] 4.1 Record the findings, required container capabilities and seccomp profile in ADR 0009 and set its status to Accepted, or write a superseding ADR; update `docs/roadmap.md` if `plugin-platform` scope changes
- [ ] 4.2 Document in `docs/dev.md` how the sandbox runs under `docker compose up --watch` with no extra local setup (ADR 0002)
