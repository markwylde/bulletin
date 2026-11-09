# 0006 — Caching strategy

**Status:** Accepted (revised after review)

## Context
Forums are read-heavy, with most requests from guests or members whose access is the same.
Responses must be very fast without Redis (ADR 0003) and must **never** leak content across
permission boundaries.

## Decision
**Principle: cache by *what the viewer can see*, never by *who the viewer is*.** Shared HTML
is keyed by the resource visibility key (ADR 0005). Per-user details are layered on separately.

### Variant key (origin)
`route + params + visibilityKey + themeId@version + pluginsGeneration + locale + colourScheme + renderFlagsHash`
- `visibilityKey`: ADR 0005 resource visibility key, including member and session grants.
- `pluginsGeneration`: bumps on any plugin install/upgrade/enable/disable/settings change (ADR 0009).
- `renderFlagsHash`: hash of the **evaluated values** of flags marked `affectsRender` for this
  viewer, not of flag definitions (ADR 0010).

### Layers
1. **CDN** caches **guest responses only**.
   - Cached only if the request carries **no session cookie and no unlock grant**, and the
     route is marked `cdnCacheable`. Every other response is `Cache-Control: private`.
   - The guest variant comes **only** from the normalised preference cookie `bp`
     (`<locale>.<theme>.<scheme>`). The CDN keys on that cookie value and ignores all other
     cookies and headers. Without `bp`, guests get the board defaults. `Accept-Language` never
     changes cached content; a client-side banner offers a matching locale and sets `bp`.
   - Guest render flags are evaluated by group targeting only, never by percentage (ADR 0010).
   - `Cache-Control: public, s-maxage=15, stale-while-revalidate=15`, and `Surrogate-Key` tags.
   - **Revocation contract**: when content stops being visible to Guests, the change triggers
     an immediate CDN purge by surrogate key **in the request path** (best-effort, short
     timeout), then a retrying worker job. The **maximum guest exposure after revocation is
     30 seconds** (`s-maxage + stale-while-revalidate`). This bound is documented in the
     staff app next to forum permission settings.
2. **In-process LRU** (`packages/cache`): rendered fragments, permission snapshots, compiled
   templates, forum tree, group/mask tables, flag definitions. Bounded by bytes.
3. **Postgres materialisations**: denormalised counters, last-post info and the forum index
   cache, maintained by workers (see Materialisations).

### Authorisation before cache
A cached item is never trusted for authorisation. Every request first computes the viewer's
`visibilityKey` from current permission state (itself cached, but validated as below). The
cache lookup includes that key, so a revoked viewer computes a different key and misses.
ETag/304 uses the same key, so a 304 cannot be issued across a permission change.

### Invalidation and consistency
- Tags are versioned in `core.cache_tags`: `forum:{id}`, `topic:{id}`, `topic:{id}:pages`,
  `member:{id}`, `perm`, `theme:{id}`, `flags`, `plugins`, `i18n:{locale}`, `announcements`.
- Each mutation declares its affected tags in one place (`domain/mutations/*`). There is no ad hoc
  invalidation. Examples:
  - reply: topic pages, topic row, forum rows, forum index, member
  - move/merge/split/approve/delete: source and destination topics and forums, all topic
    pages, search
  - permission/mask/group change: `perm`
- Tag versions are bumped **in the same transaction** as the write, then `NOTIFY` wakes other
  processes.
- **Listener protocol (fail closed)**:
  1. On connect: `LISTEN` first, then read all tag versions (avoids the setup race).
  2. Each process sends itself a heartbeat `NOTIFY` every 2 s.
  3. If the listener connection drops, or a heartbeat is late by more than 5 s, the process
     marks its local cache **untrusted**. It then serves from Postgres, bypassing the LRU,
     until it reconnects and reloads versions.
- The `perm` version is also checked against Postgres **at most once per second per process**,
  as a backstop independent of NOTIFY. The worst-case in-process revocation window is
  therefore 1 s.

### Materialisations
- Request paths read authoritative tables on a cache miss. Materialised counters are allowed to
  be eventual. **Visibility and deletion state are never read from a materialisation.**
- A worker that updates a materialisation bumps its tags **in the same transaction** as the
  update. `NOTIFY` is transactional, so it is delivered on commit. A fragment rebuilt before
  the commit recorded the old tag version, so it is invalidated. A crash rolls back both the
  update and the bump, and the job retries.
- Materialisations carry a `source_version`, and workers only apply updates newer than the stored one.

### Personal overlay
Anything per-user (unread markers, notification counts, ignored members, "you reacted",
drafts, PM count, mod-queue counts) is **never** in shared HTML. `GET /api/me/overlay?ctx=…`
returns private JSON, and a tiny island applies it after paint. Ignored members' posts are
collapsed client-side.

### Rules
- Cache code lives only in `packages/cache`. Other code declares `{ key, tags, ttl }`.
- Required tests: for every cached route, a permission change, password unlock, member mod
  assignment, flag change and plugin toggle must each produce a different variant, and hidden
  content must never appear in another variant.
- Dev headers: `X-Cache: HIT|MISS|STALE|BYPASS` and `X-Cache-Key`.
- Targets on the seeded dataset (warm): p95 TTFB < 30 ms for cached guest pages, < 80 ms for
  member pages, < 200 ms for cold renders.
- Variant cardinality is monitored per route (ADR 0020).

## Consequences
- Guests can see newly hidden content for up to 30 s, and members for up to 1 s. Both are
  documented and tested.
