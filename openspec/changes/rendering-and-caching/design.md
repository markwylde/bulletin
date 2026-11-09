# Design

## Context

ADRs 0006 and 0008 fix the approach; this change is spike S1. The first task group is a
time-boxed proof (2 days) whose outcome updates ADR 0008. If the proof fails, stop and
write a superseding ADR before continuing.

## Goals / Non-Goals

**Goals:** a production-quality template engine, island runtime and cache stack, proven on
the index and forum pages.

**Non-Goals:** theme management UI (change 18); plugin hooks content (change 19).

## Decisions

- **Process boundary** (ADR 0001): user-app connects to Postgres as `user_app`. It builds view
  models in-process from `packages/domain`, and runs its own LISTEN connection and LRU.
  user-api handles all writes and JSON endpoints, and never renders HTML.
- **Request pipeline (user-app)**:
  1. Astro middleware resolves the session (direct DB lookup, cached per ADR 0006), locale,
     theme and scheme, and the capability snapshot.
  2. The route's `buildViewModel(ctx)` declares `deps` and `tags`.
  3. `cache.getOrRender(variantKey, tags, () => engine.render(template, vm))`.
  4. Astro wraps the result in the shell with the asset manifest, CSP nonce and the overlay
     bootstrap script.
- **Islands**:
  - The registry maps a name to `{ component, propsSchema (valibot), chunk }`.
  - The server renders with `renderToString` and emits `<bl-island data-name data-props>`.
  - The client runtime (≤ 3 KB) uses `IntersectionObserver` for below-the-fold islands and
    calls `hydrateRoot`.
  - Chunks come from a Vite build of `packages/ui/islands` (run by Astro), and the manifest is
    read at startup.
- **Adapter**: evaluate `@nurodev/astro-bun` (or the current maintained Bun adapter) versus
  `@astrojs/node` standalone under Bun. Pick on correctness of streaming and headers first,
  then speed. Record the choice in ADR 0008.
- **Template safety**:
  - Templates are parsed with LiquidJS (`strictFilters`, `strictVariables`, `ownPropertyOnly`,
    `outputEscape: 'escape'`).
  - Static markup is checked at save time by parsing the template's literal HTML parts with
    `parse5` and applying the theme sanitiser profile.
  - Rendered fragments are re-sanitised at fragment build and cached.
  - Limits: `renderLimit` 50 ms, `memoryLimit` 10 MB, `parseLimit` 1 MB, include depth 10,
    output 2 MB.
- **Cache store**: a byte-bounded LRU (default 256 MB per process). Entries hold `{ html, tagVersions }`.
  - On read: if trusted and the tag versions match the current local versions, return the
    entry; otherwise rebuild.
  - The listener follows ADR 0006 (LISTEN first, then load versions; 2 s heartbeat).
- **Mutation tags**: `domain/mutations/*.ts` exports `{ name, tags(input, result) }`. Writes go
  through `runMutation`, which bumps versions in the transaction. A lint rule forbids direct
  `cache_tags` writes.
- **CDN**: a route flag `cdnCacheable`. The response helper sets headers based on session
  presence and unlock grants. A purge hook runs in the request path with a 300 ms timeout,
  then enqueues a job.
- **Overlay**: `GET /api/me/overlay?ctx=forum:12` returns JSON with `private, no-cache` and an
  ETag. A client script applies it to `data-overlay-*` hooks in templates.

## Risks / Trade-offs

- [Liquid + SSR React per request is slow] → fragments are cached; islands SSR is part of the
  cached fragment when its props are not personal.
- [Adapter immaturity] → the `@astrojs/node` fallback is supported by Astro.
- [Fail-closed bypass overloads Postgres during a listener outage] → a bypass rate alert, and
  the listener reconnects with backoff (ADR 0020).

## Migration Plan

Not applicable (greenfield). After the spike, update ADR 0008's status to Accepted with findings.
