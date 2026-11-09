# 0015 — Testing strategy

**Status:** Accepted (revised after review)

## Decision
- **`bun test`** for unit and integration tests. Integration tests run against real Postgres
  (the compose service), with a fresh database per test file cloned from a migrated template DB.
  No DB mocking in integration tests.
- **E2E uses `Bun.WebView`**, not Playwright. The API is experimental, so:
  - **Bun is pinned** (exact version in `package.json` `packageManager` and in Dockerfiles).
  - The **CI E2E image** is pinned and contains a pinned Chromium. The Chrome backend is
    selected explicitly so macOS (WKWebView default) and CI behave the same. Each test gets
    an isolated, temporary profile.
  - Helpers live in `packages/test-utils`: log in as a seeded darkauth-mock profile, viewport
    presets, screenshots, waiting for hydration.
  - Playwright is allowed only if a new ADR shows a hard gap.
- E2E runs against the full stack: `docker compose -f compose.yaml -f compose.test.yaml`.
- **Viewports**: 360×780 (minimum supported), 390×844 and 1440×900.
- Required coverage per feature:
  - domain rules: unit tests
  - API endpoints: integration tests, **including permission-denial cases**
  - caching: variant and invalidation tests (ADR 0006)
  - sanitiser and theme templates: XSS corpus (ADR 0007, 0008)
  - plugins: the malicious-plugin suite (ADR 0009)
  - PII: role and RLS denial tests (ADR 0012)
  - i18n: catalog completeness
  - user journeys: E2E at the three viewports
- **Real-device acceptance checklist**, run per release on one iOS and one Android device:
  editor input, PWA install, push and offline behaviour. These can't be simulated by viewport size.
- Performance and capacity tests are defined in ADR 0020.
- CI runs `bun run check` plus E2E on Docker and Podman. A red build blocks merge.

## Consequences
- Tests are part of "done"; a feature without its required tests is not done.
