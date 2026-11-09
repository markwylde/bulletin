# Tasks

## 1. Spike S2 (time-boxed)

- [ ] 1.1 Prototype nsjail inside plugin-host under Docker and rootless Podman (UID mapping, empty netns, cgroup limits, seccomp, Unix socket); record the required capabilities and findings in ADR 0009, and set its status to Accepted (or write a superseding ADR)
- [ ] 1.2 Prototype the broker DB path with `plugin_<id>` and `_owner` roles and the statement allowlist; run the first 5 malicious cases and record the results

## 2. Runtime

- [ ] 2.1 Implement the supervisor (spawn, health, restart with backoff, kill on limits) with integration tests for the fork-bomb and memory scenarios
- [ ] 2.2 Implement the broker (JSON-RPC, DB allowlist, role connections, rate and concurrency limits, egress proxy with SSRF rules, core API forwarding with viewer context) with tests for the network, core-read, runtime-DDL and undeclared-host scenarios
- [ ] 2.3 Implement the storage quota monitor and write revocation, plus the shared-cluster warning, with an integration test
- [ ] 2.4 Implement the full malicious-plugin suite and run it in CI on Docker and Podman

## 3. SDK and hooks

- [ ] 3.1 Implement `packages/plugin-sdk` (manifest schema, hook registration, core APIs, jobs, kv, i18n, GDPR hooks) with semver and shim scaffolding; unit tests
- [ ] 3.2 Template fragments and overrides merged at compile time per `pluginsGeneration`, with a test for the hide-post-count scenario and a cache variant test for plugin toggles
- [ ] 3.3 View-model enrichers with deadlines, dependency declarations and the viewer-intersection principal; tests for the timeout and privileged-plugin-guest-viewer scenarios
- [ ] 3.8 Broker `cache.invalidate(tags[])` scoped to `plugin:<id>:*` (transactional when inside a broker DB transaction, rate-limited and coalesced), with enrichers and plugin fragments declaring these tags; tests for the plugin-data-changes and foreign-tag scenarios
- [ ] 3.4 Write filters and veto filters with the 300 ms budget and fail-open/closed modes; tests for each scenario
- [ ] 3.5 Plugin event subscribers via per-plugin queues, plus content extensions with core sanitisation; tests
- [ ] 3.6 Plugin routes (themed pages and API), jobs, and registry entries (settings, forum actions, flags); test for the plugin forum action in the matrix
- [ ] 3.7 Client apps on the plugin origin, sandboxed frames and the validated bridge; E2E tests for the bridge call and cookie-isolation scenarios

## 4. Lifecycle

- [ ] 4.1 Marketplace catalog browsing, compatibility, signature/checksum verification and the capability review with step-up auth; tests for the tampered-bundle scenario
- [ ] 4.2 Install, upgrade (quiesce, single-transaction migrate, activate, resumable journal), disable and uninstall (export/erase hooks, keep or drop schema); tests for every lifecycle scenario
- [ ] 4.3 Circuit breaker and auto-disable with admin notification, with a test
- [ ] 4.4 Service principal defaulting to Guests, and elevated grants with a warning and admin log entry; tests

## 5. Staff integration

- [ ] 5.1 Plugin settings via the form DSL, extension-point sections, and fixed page types in the staff section registry; tests for validation and that core fields are untouched; E2E at 360
- [ ] 5.2 Plugin manager screen (state, capabilities, grants, timings, errors, actions), with permission-denial tests

## 6. Strings, samples and seed

- [ ] 6.1 Add en/es/fr strings for the plugin manager, capability descriptions and errors; verify completeness, and that sample plugin catalogs validate
- [ ] 6.2 Build the three sample plugins and publish them in `mocks/marketplace`; seed `hide-post-count` (disabled), `welcome-bot` and `tip-jar` (enabled); verify they work after `docker compose up --watch`
- [ ] 6.3 Write `docs/plugins/` (SDK guide, hook reference, capability list, sandbox limits) and verify the sample plugins follow it
