# Tasks

## 1. Workspace scaffolding

- [x] 1.1 Create the Bun workspace root (`package.json` with workspaces and `packageManager` pinning Bun, `tsconfig.base.json` strict, Biome config) and verify `bun install` succeeds
- [x] 1.2 Create shells for `apps/{user-app,user-api,staff-app,staff-api,workers,plugin-host}` and `packages/{db,domain,cache,content,templates,plugin-sdk,i18n,flags,storage,ui,config,test-utils}` and verify `bun run check` (typecheck + lint + tests) passes
- [x] 1.3 Implement `packages/config` env parsing with dev defaults, production rejection of dev defaults, and a log redaction helper; verify with unit tests for rejection and redaction

## 2. Compose stack and proxy

- [x] 2.1 Write per-app multi-stage Dockerfiles and `compose.yaml` services with `develop.watch` (sync / sync+restart / rebuild) and verify a source edit reloads without a rebuild
- [x] 2.2 Add Postgres (pinned) with a data volume and the Caddy proxy with the ADR 0018 hostnames; verify all origins respond through `*.bulletin.localhost:8080`
- [x] 2.3 Add darkauth-mock (image, volume, `darkauth-mock.yaml` with `bulletin-user` and `bulletin-staff` clients and the seeded profiles) and verify with an integration test that the code flow for a profile returns an ID token verifiable via JWKS

## 3. Mocks

- [ ] 3.1 Build `mocks/s3` (SigV4 presign, put/get/head/delete/copy/list, Postgres storage, UI) with a contract test suite and verify the round-trip and restart scenarios
- [ ] 3.2 Build `mocks/mail` (SMTP listener and inbox UI) and verify a test email appears
- [ ] 3.3 Build `mocks/push`, `mocks/webhooks` (with signature verification display) and `mocks/oembed`, each with a UI and capture tests
- [ ] 3.4 Build `mocks/cdn` (cache honouring `Cache-Control`, `bp`-cookie keying, surrogate-key purge, `X-Cache` header) and verify the purge-by-key scenario
- [ ] 3.5 Build `mocks/marketplace` as a stub registry serving a signed empty catalog, and verify the signature validates with the dev public key
- [ ] 3.6 Add the architecture test that fails if app code references mock-only flags or hostnames, and verify it catches a planted violation
- [ ] 3.7 Implement the basic `packages/storage` client over `Bun.S3Client` (put, get, delete, presign GET/PUT, opaque keys) against `mocks/s3`, with contract tests; the upload state machine is added in `attachments-avatars`
- [ ] 3.8 Implement `safeFetch` in `packages/domain/net` (resolve once, block ranges per ADR 0016, connect to the pinned IP, HTTPS-only in production, redirect policy, caps, dev allowlist rejected in production) with tests for each blocked range, a DNS-rebinding test, and the redirect re-check

## 4. Database lifecycle

- [ ] 4.1 Implement the migration runner (ordering, checksums, advisory lock, per-file transaction) with integration tests for the concurrent-start and edited-migration scenarios
- [ ] 4.2 Create migration `0001` with schemas `core` and `pii`, owner roles (`bulletin_owner`, `pii_owner`) and login roles (`user_app`, `user_api`, `staff_api`, `workers`) per ADRs 0001 and 0012 (no tables yet beyond `schema_migrations`, `seed_runs`, `cache_tags`); verify role privileges with tests
- [ ] 4.3 Implement the ID and URL convention helpers (`/<kind>/<id>-<slug>`, ID-only resolution, canonical 301) in `packages/domain`, with unit tests for missing, outdated and correct slugs
- [ ] 4.4 Implement the seed framework (module registry, seeded RNG, `SEED_SIZE`, run-once guard) and verify the reproducibility scenario with a test comparing two seeded databases
- [ ] 4.5 Wire pg-boss (own schema, `workers` role) and implement the domain-event outbox: `core.events`, `core.event_deliveries`, `core.job_cursors`, the typed catalog file, `emit()` inside mutation transactions, and the relay (claim, per-subscriber delivery rows, singleton enqueue, published marking); integration tests for the rolled-back, subscriber-isolation and crash-between-steps scenarios using a test subscriber

## 5. Health and lifecycle

- [ ] 5.1 Implement shared `/health/live` and `/health/ready` plus SIGTERM drain in a common server helper used by every service, with integration tests for the DB-down and in-flight-request scenarios
- [ ] 5.2 Implement the connection budget check and verify an over-budget configuration refuses to start

## 6. Test harness

- [ ] 6.1 Implement per-file template databases for `bun test` and verify two test files run in parallel without interference
- [ ] 6.2 Implement `Bun.WebView` E2E helpers (Chrome backend, temp profile, viewport presets; `loginAs` is added by `identity-sessions` and `waitForHydration` by `rendering-and-caching`) and an E2E smoke test that opens both apps at all three viewports
- [ ] 6.3 Add `compose.test.yaml` and the E2E runner script, and verify the smoke test passes against the full stack

## 7. i18n and seed placeholders

- [ ] 7.1 Add placeholder en/es/fr strings for the placeholder pages via a minimal catalog file (replaced by change `i18n-foundation`) and verify the pages render in each locale
- [ ] 7.2 Add the base seed module (board settings row only) and verify `docker compose up --watch` on an empty DB records a seed run

## 8. CI and docs

- [ ] 8.1 Add CI workflows: `bun run check` plus the compose E2E job on Docker and Podman; verify both pass on a PR
- [ ] 8.2 Write `README.md` (two-step start, supported engines and versions, hostnames, mock UIs, reset with `down -v`) and verify the steps on a clean machine
- [ ] 8.3 Verify the offline scenario: after the first start, disconnect the network, restart, and confirm the stack becomes healthy
