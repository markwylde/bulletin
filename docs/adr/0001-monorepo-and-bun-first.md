# 0001 — Monorepo layout and Bun-first tooling

**Status:** Accepted (revised after review)

## Context
Bulletin is a classic community forum (Invision Power Board 1.x/2.x era feature set) built
as several apps that share types, DB access and domain logic.

## Decision
- One Bun workspace monorepo. TypeScript everywhere, `strict: true`.
- Layout:
  ```
  apps/
    user-app/      Astro (SSR; adapter pinned by spike S1, ADR 0008) + React islands — the public forum
    user-api/      Bun.serve HTTP API for the user app, SSE, public API
    staff-app/     Vite + React SPA — Admin/Mod control panel (no theming)
    staff-api/     Bun.serve HTTP API for the staff app
    workers/       pg-boss consumers + cron schedules
    plugin-host/   plugin sandbox supervisor + broker (ADR 0009)
    proxy/         Caddy config for local origins (ADR 0018)
  mocks/           local-only stand-ins for external services (ADR 0002)
  packages/
    db/            SQL migrations, migration runner, typed query helpers
    domain/        business rules (permissions, posting, moderation…), framework-free
    cache/         cache layers + invalidation (ADR 0006)
    content/       markdown → sanitised HTML pipeline (ADR 0007)
    templates/     theme template engine + hook points (ADR 0008)
    plugin-sdk/    public, versioned SDK plugins compile against
    i18n/          message catalogs + formatter (ADR 0013)
    flags/         feature flag evaluation (ADR 0010)
    storage/       Bun.S3Client wrapper: keys, presigning, upload state machine (ADR 0019)
    ui/            shared React components (user-app islands + staff-app)
    config/        env parsing/validation (fail fast on bad config)
    test-utils/    fixtures, seed builders, WebView helpers
  ```
- **Use Bun built-ins before adding a dependency**: `Bun.serve` (HTTP, routing, SSE),
  `Bun.sql` (Postgres), `Bun.S3Client` (object storage), `Bun.password`, `Bun.CryptoHasher`,
  `bun test`, `Bun.WebView` (browser automation, ADR 0015; experimental, so Bun is pinned), `Bun.spawn`, `Bun.file`,
  `bun build`. A new dependency needs a one-line justification in the PR.
- Allowed core dependencies: `astro`, `react`, `vite`, `pg-boss`, `@milkdown/*` (ADR 0007),
  `liquidjs` (ADR 0008), `@darkauth/client`, `jose` (JWT/JWKS), `sharp` (ADR 0019),
  the markdown/HAST toolchain (`unified`, `remark-*`, `rehype-*`, `rehype-sanitize`), plus:

  | Dependency | Why (no Bun built-in covers it) |
  |---|---|
  | `valibot` | runtime validation of request bodies, island props, plugin manifests and form DSL; small and tree-shakeable |
  | `react-router` | staff-app client routing |
  | `@tanstack/react-query` | staff-app and island server-state caching, retries and invalidation |
  | `intl-messageformat` | ICU plurals and selects for en/es/fr (ADR 0013); `Intl` alone has no message format |
  | `parse5` | spec-compliant HTML parsing for template validation (ADR 0008) |
  | `lightningcss` | parsing and sanitising theme CSS (ADR 0008) |
  | `libpg-query` | parsing plugin SQL for the broker statement allowlist and migration validation (ADR 0009) |
  | `file-type` | magic-byte detection for uploads (ADR 0019) |
  | `@opentelemetry/api` + OTLP exporter | traces and metrics (ADR 0020) |
  | `web-push` | VAPID signing and payload encryption for push (ADR 0014) |
  | `rehype-highlight` | server-side code highlighting in the content pipeline (ADR 0007) |
  | `@scalar/api-reference` (static bundle) | rendering the generated OpenAPI docs (ADR 0016) |
  | `fflate` | zipping GDPR exports and theme/plugin bundles (ADR 0012) |
  Infrastructure images: Postgres, Caddy, nsjail (in plugin-host).
- **user-app ↔ user-api boundary**: user-app (Astro SSR) builds page view models
  **in-process** from `packages/domain`. It talks to Postgres directly with its own login role
  `user_app`, which has read-mostly grants: reads of core content plus writes only to
  the UNLOGGED read-path buffers (presence, views, redirect-forum clicks). It holds its own query pool and one LISTEN connection. It owns
  the rendered-fragment LRU (ADR 0006) and invalidates it from NOTIFY like every other process.
  user-api serves JSON: mutations, overlay, SSE, auth, uploads and `/api/v1`. All writes go
  through user-api; user-app never calls user-api over HTTP to render a page.
- **IDs and URLs**: all entity primary keys are `bigint GENERATED ALWAYS AS IDENTITY`. Secrets
  are never keys (sessions use a bigint ID plus a unique token hash), and only small registry
  tables keyed by a code-defined name (feature flags, settings, cache tags) use a text key. Public URLs
  are `/<kind>/<id>-<slug>`: `/forum/12-general-discussion`, `/topic/345-welcome`,
  `/profile/77-jane`. Routes resolve **by numeric ID only**. A missing or outdated slug
  301-redirects to the current canonical URL. Paged topics use `/topic/345-welcome/page/2`,
  and posts `/topic/345-welcome/post/9876` (redirects to the right page and anchor). Cache
  keys and moved-topic stubs use IDs, never slugs.
- Migrations are plain, forward-only `.sql` files in `packages/db/migrations`, applied by our
  own small runner on container start. No ORM; typed helpers over `Bun.sql`.
- Biome for lint + format. One root `bun run check` runs typecheck, lint, tests.

## Consequences
- Fewer moving parts; tooling is consistent across apps.
- pg-boss brings its own `pg` driver internally; that is acceptable.
