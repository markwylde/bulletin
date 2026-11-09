# Tasks

## 1. Spike S1 (time-boxed)

- [ ] 1.1 Prototype: a DB-stored Liquid template places an island, which SSRs and hydrates in Astro under both adapter candidates; record the findings and the adapter choice in ADR 0008 and set its status to Accepted
- [ ] 1.2 Prototype: a plugin-style hook fragment and a theme switch produce distinct cache entries and correct hydration; measure render cost and record it in ADR 0008

## 2. Template engine

- [ ] 2.1 Implement `packages/templates` (DB template loading with parent fallback, compile cache keyed by theme version and plugin generation, `{% t %}`, `{% island %}`, `{% hook %}`, autoescape, `SafeHtml` type) with unit tests for fallback and escaping
- [ ] 2.2 Implement save-time template validation (parse5 + theme sanitiser profile) with an XSS corpus test covering every rejected construct
- [ ] 2.3 Implement resource limits and parent fallback on violation, with tests for the runaway-loop scenario
- [ ] 2.4 Implement view-model contracts for the index and forum routes, with `deps`/`tags` declarations and contract tests

## 3. Islands

- [ ] 3.1 Implement the island registry, props validation, SSR emission and the client hydration runtime, with unit tests and an E2E hydration test at all viewports
- [ ] 3.2 Implement the required-islands check per route and the hook registry check in CI, with tests for both failure scenarios

## 4. Default theme skeleton

- [ ] 4.1 Port the index and forum pages from change 7 into default-theme templates (mobile-first, light/dark tokens), and verify existing E2E tests still pass at 360/390/1440

## 5. Cache stack

- [ ] 5.1 Implement `packages/cache` (byte-bounded LRU, variant keys, tag versions, `getOrRender`) with unit tests
- [ ] 5.2 Implement the listener protocol (LISTEN-then-load, heartbeat, untrusted/BYPASS mode, reconnect) and the 1 s `perm` backstop, with integration tests that kill the listener connection
- [ ] 5.3 Implement `runMutation` with declared tags and the lint rule against direct tag writes; integration tests for the new-reply invalidation scenario using a stub mutation
- [ ] 5.4 Implement cache variant tests as a reusable harness (permission change, password unlock, member mod assignment, flag change and plugin generation each produce a distinct variant with no leaked content), and apply it to the index and forum routes

## 6. HTTP layer

- [ ] 6.1 Implement CDN eligibility, the `bp` cookie variant, `Cache-Control`, `Surrogate-Key`, ETag/304 and the dev diagnostic headers, with integration tests for each scenario via the CDN mock
- [ ] 6.2 Implement purge on guest revocation (request-path best effort plus retrying job) and the 30 s window note in the staff app; integration test for the forum-made-private scenario
- [ ] 6.3 Implement the overlay endpoint and client applier (unread placeholder, counts, CSRF token), with an integration test that shared HTML contains no personal data

## 7. Performance

- [ ] 7.1 Add the latency benchmark against the seeded stack (cached guest, member and cold) and wire it into CI; verify the thresholds pass

## 8. Strings and seed

- [ ] 8.1 Add en/es/fr strings for template validation errors and cache settings notes; verify completeness
- [ ] 8.2 Seed the default theme into the DB from repo files, and verify the index renders from the DB-stored templates after `docker compose up --watch`
