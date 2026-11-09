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
  the markdown/HAST toolchain (`unified`, `remark-*`, `rehype-*`, `rehype-sanitize`).
  Infrastructure images: Postgres, Caddy, nsjail (in plugin-host).
- Migrations are plain, forward-only `.sql` files in `packages/db/migrations`, applied by our
  own small runner on container start. No ORM; typed helpers over `Bun.sql`.
- Biome for lint + format. One root `bun run check` runs typecheck, lint, tests.

## Consequences
- Fewer moving parts; tooling is consistent across apps.
- pg-boss brings its own `pg` driver internally; that is acceptable.
