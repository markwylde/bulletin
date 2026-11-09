# Bulletin — agent instructions

Bulletin is a community forum (IPB 1.x/2.x-style) built as a Bun monorepo.

**Before any work, read [`docs/adr/README.md`](docs/adr/README.md) and every ADR relevant to
your change, plus [`docs/features.md`](docs/features.md).** ADRs are binding. If your change
needs to contradict one, stop and propose a superseding ADR first.

Spikes S1 (templates/islands) and S2 (plugin sandbox) must land before feature work that
depends on them.

Non-negotiables (details in the ADRs):
- Local dev is two steps: clone, then `docker compose up --watch`. Every external service is
  mocked in `mocks/`. Seed data must be rich. (0002)
- Postgres is the only stateful service. NOTIFY is a wake-up only; durable state is in tables. (0003)
- Identity comes from DarkAuth; all authorisation lives in Bulletin groups, masks and
  moderators, via `can()` only. (0004, 0005)
- Cache by the resource visibility key, never by user. Personal data goes through the overlay.
  The CDN caches guests only. Fail closed when invalidation is unhealthy. (0006)
- Themes are untrusted: autoescaped, sanitised, resource-limited. Plugins are untrusted:
  sandboxed and brokered server code, with client code only in sandboxed iframes. (0008, 0009)
- Restricted PII is only reachable through audited definer functions in `pii`. Job payloads
  carry IDs only. (0011, 0012)
- Separate origins: user, staff, files, plugins. Host-only cookies, CSRF token plus Origin check. (0018)
- Attachments are private and authorised on every download. (0019)
- user-app renders in-process from `packages/domain` with its own read role; all writes go through user-api. IDs are bigint; URLs are `/<kind>/<id>-<slug>` resolved by ID. (0001)
- Visits (views, presence, read markers) are recorded via the overlay or guest beacon, never by invalidating content caches. (0006)
- Prefer Bun built-ins. E2E uses `Bun.WebView`, not Playwright. (0001, 0015)
- Mobile-first at 360 px; en/es/fr; no hard-coded strings. (0013, 0014)
- Every feature ships with tests, including permission-denial and cache-variant tests. (0015)
