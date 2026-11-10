# Design

## Context

ADRs 0006 and 0008 fix the approach; this change is spike S1. The first task group is a
time-boxed proof (2 days) whose outcome updates ADR 0008. If the proof fails, stop and
write a superseding ADR before continuing.

## Goals / Non-Goals

**Goals:** a production-quality template engine, island runtime and cache stack, proven on a
dev-only demo route before any feature page exists. It runs straight after `groups-permissions`,
so `forum-structure` and every later change render through templates, view-model contracts and
the cache variant harness from their first commit.

**Non-Goals:** theme management UI (change `themes`); plugin hooks content (change `plugin-platform`).

## Decisions

- **Demo route**: `/_demo/<id>` (enabled only when `NODE_ENV != production`) renders a fixture
  resource tree supplied through the `ForumTree` test provider from `groups-permissions`. It
  uses one island, one `{% hook %}` point, a password-style unlock, a moderator-only control
  and an overlay field, so every variant dimension and invalidation path is exercised. The
  harness, benchmark and E2E tests target it until real routes take over.
- **Route contract for later changes**: every user-app route ships a view-model contract
  (`deps`, `tags`, CDN eligibility, required islands), default-theme templates, and a
  registration in the variant harness. A route without these fails CI.

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
- **Overlay**: `POST /api/me/overlay` with `{ctx: "forum:12"}` (CSRF-exempt bootstrap per ADR 0018) returns JSON with `private, no-cache` and an
  ETag. A client script applies it to `data-overlay-*` hooks in templates.

## Risks / Trade-offs

- [Liquid + SSR React per request is slow] → fragments are cached; islands SSR is part of the
  cached fragment when its props are not personal.
- [Adapter immaturity] → the `@astrojs/node` fallback is supported by Astro.
- [Fail-closed bypass overloads Postgres during a listener outage] → a bypass rate alert, and
  the listener reconnects with backoff (ADR 0020).

## Migration Plan

Not applicable (greenfield). After the spike, update ADR 0008's status to Accepted with findings.

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| Overlay responses (unread state, counts, CSRF token) | Personal content | personalisation | not stored; `private, no-cache` | the session member only | — | — |
| Guest beacon cookie ID | Personal data (pseudonymous) | view counting, presence | cookie 30 days; buffer rows flushed each minute | none (aggregated) | excluded | not linkable to a member |
| Presence and view buffers (UNLOGGED) | Derived | who's online, view counts | 15 minutes | aggregated only | excluded | deleted by expiry |
| Shared fragment cache and CDN | Derived | performance | tag invalidation or TTL | per visibility key; never holds personal data (enforced by the no-personal-data test) | — | purged by invalidation |

## Feature flags (ADR 0010)

None: rendering and caching are core. The language switcher and account pages are core reading, exempt under ADR 0010.
