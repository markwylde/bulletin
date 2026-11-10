# Tasks

## 1. Spike S1 (time-boxed)

- [x] 1.1 Prototype: a DB-stored Liquid template places an island, which SSRs and hydrates in Astro under both adapter candidates; record the findings and the adapter choice in ADR 0008 and set its status to Accepted
- [x] 1.2 Prototype: a plugin-style hook fragment and a theme switch produce distinct cache entries and correct hydration; measure render cost and record it in ADR 0008

## 2. Template engine

- [x] 2.1 Implement `packages/templates` (DB template loading with parent fallback, compile cache keyed by theme version and plugin generation, `{% t %}`, `{% island %}`, `{% hook %}`, autoescape, `SafeHtml` type) with unit tests for fallback and escaping
- [x] 2.2 Implement save-time template validation (parse5 + theme sanitiser profile) with an XSS corpus test covering every rejected construct
- [x] 2.3 Implement resource limits and parent fallback on violation, with tests for the runaway-loop scenario
- [x] 2.4 Implement the view-model contract API (`deps`, `tags`, CDN eligibility, required islands) and the CI check that every user-app route declares one, with contract tests on the demo route

## 3. Islands

- [x] 3.1 Implement the island registry, props validation, SSR emission and the client hydration runtime, with unit tests and an E2E hydration test at all viewports
- [ ] 3.2 Implement the required-islands check per route and the hook registry check in CI, with tests for both failure scenarios

## 4. Default theme skeleton

- [ ] 4.1 Build the default theme skeleton (layout, header, breadcrumbs, empty and error states, mobile-first light/dark tokens) with E2E at 360/390/1440
- [ ] 4.2 Build the dev-only `/_demo/<id>` route over the fixture `ForumTree` provider (island, hook point, unlock, mod-only control, overlay field), and a test that it returns 404 in production mode
- [ ] 4.3 Build the first personal routes on the template stack: the display-name step (with the redirect guard for members without a name) and the account page (display name change with history, active sessions list, language), all `private, no-store`; E2E for a new member at 360 px
- [ ] 4.4 Language switcher island (member saves preference, guest sets `bp`) and the `Accept-Language` suggestion banner in the default theme; E2E at all viewports for switching as guest and as member

## 5. Cache stack

- [ ] 5.1 Implement `packages/cache` (byte-bounded LRU, variant keys, tag versions, `getOrRender`) with unit tests
- [ ] 5.2 Implement the listener protocol (LISTEN-then-load, heartbeat, untrusted/BYPASS mode, reconnect) and the 1 s `perm` backstop, with integration tests that kill the listener connection
- [ ] 5.3 Implement `runMutation` with declared tags and the lint rule against direct tag writes; integration tests for the new-reply invalidation scenario using a stub mutation
- [ ] 5.4 Implement cache variant tests as a reusable harness (permission change, password unlock, member mod assignment, flag change and plugin generation each produce a distinct variant with no leaked content), and apply it to the demo route; later changes register their routes with it

## 6. HTTP layer

- [ ] 6.1 Implement CDN eligibility, the `bp` cookie variant, `Cache-Control`, `Surrogate-Key`, ETag/304 and the dev diagnostic headers, with integration tests for each scenario via the CDN mock
- [ ] 6.2 Implement purge on guest revocation (request-path best effort plus retrying job) and the 30 s window note in the staff app; integration test for the forum-made-private scenario
- [ ] 6.3 Implement the overlay endpoint and client applier (unread placeholder, counts, CSRF token), with an integration test that shared HTML contains no personal data
- [ ] 6.4 Implement the visit-recording side channel: overlay side effects for members and `POST /api/beacon` for guests (guest cookie ID, per-IP rate limit, UNLOGGED buffers), with tests for the guest-view-on-CDN and views-do-not-invalidate scenarios
- [ ] 6.5 Give user-app its `user_app` DB pool and LISTEN connection, and add a test that user-app performs no writes outside the UNLOGGED read-path buffers (presence, views, redirect clicks)

## 7. Performance

- [ ] 7.1 Add the latency benchmark against the seeded stack (cached guest, member and cold) on the demo route, with an extension point for later routes to register and wire it into CI; verify the thresholds pass

## 8. Strings and seed

- [ ] 8.1 Add en/es/fr strings for template validation errors and cache settings notes; verify completeness
- [ ] 8.2 Seed the default theme into the DB from repo files, and verify the demo route renders from the DB-stored templates after `docker compose up --watch`
