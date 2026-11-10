# Tasks

## 1. Evaluation

- [x] 1.1 Implement `packages/flags` (definitions, rule evaluation, stable bucketing, guest rule for `affectsRender`) with unit tests for targeting, stability, monotonic increase and guests
- [x] 1.2 Add the `core.feature_flags` migration, the code-registry upsert on startup, and cached loading with tag invalidation; integration test for promptness (≤ 1 s)
- [ ] 1.3 Implement `requireFlag` middleware and accessors (server, template tag, React hook, client-visible export) with tests including the 404 scenario

## 2. Staff UI

- [ ] 2.1 Add the flags section (list, staleness highlight, rule editor using the form renderer, admin log entries) gated by `acp.flags`; integration test with permission denial; E2E at 360 and 1440

## 3. Strings and seed

- [ ] 3.1 Add en/es/fr strings for the flags section; verify completeness
- [ ] 3.2 Seed three example flags (group-targeted, 50% rollout, render-affecting), and verify they show in the staff app after `docker compose up --watch`
