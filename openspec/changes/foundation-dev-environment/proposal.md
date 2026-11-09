# Proposal

## Why

Nothing exists yet. Every later change needs the monorepo, the compose stack, the local
mocks, migrations, seeding and the test harness. ADR 0002 requires that the whole stack runs
with two steps (clone, `docker compose up --watch`), with Postgres as the only stateful service.

## What Changes

- Bun workspace monorepo with the layout from ADR 0001 (empty app and package shells that build and pass `bun run check`).
- `compose.yaml` with Postgres, Caddy proxy (ADR 0018 hostnames), all app services with `develop.watch`, and all mocks.
- Mocks: darkauth-mock (image + `darkauth-mock.yaml`), s3, mail, push, marketplace, webhooks, oembed, cdn.
- SQL migration runner with advisory lock and checksums; runs on API start.
- Deterministic seed framework that runs on an empty DB (content grows as later changes add seed modules).
- Health endpoints, graceful drain, and connection budget check (ADR 0020).
- Test harness: `bun test` with per-file template-cloned databases, and `Bun.WebView` E2E helpers.
- CI running checks and E2E on Docker and Podman.

## Capabilities

### New Capabilities
- `dev-environment`: two-step local startup, watch behaviour, migrations, seeding, supported engines.
- `local-mocks`: config-driven local stand-ins for every external service, with inspection UIs.
- `service-health`: liveness/readiness, graceful shutdown and connection budget enforcement for every service.

### Modified Capabilities
- None.

## Impact

- Creates `apps/*`, `packages/*`, `mocks/*`, `compose.yaml`, `compose.test.yaml`, `darkauth-mock.yaml`, `Caddyfile`, CI workflows.
- Pins Bun, Postgres and Chromium (E2E image) versions.
