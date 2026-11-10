# Proposal

## Why

ADR 0008 (templates and islands) and ADR 0006 (caching) are the riskiest architecture in the
project. Spike S1 must prove them before content features are built on top. This change *is*
spike S1, promoted into production code: the template engine, the island runtime, the
default theme skeleton, and the full caching stack.

## What Changes

- LiquidJS-based template engine with DB-stored templates, typed view models, `{% island %}`, `{% hook %}`, `{% t %}` and autoescaping.
- Island registry and client hydration runtime.
- Default theme skeleton (layout, tokens, light/dark, header, breadcrumbs, empty states) plus a dev-only demo route that exercises every mechanism over a fixture resource tree. Real pages (`forum-structure` onward) are built on this from day one.
- `packages/cache`: variant keys, versioned tags, in-process LRU, NOTIFY listener protocol with heartbeat and fail-closed mode, 1 s permission backstop, and mutation tag declarations.
- Personal overlay endpoint and client applier.
- HTTP layer: CDN eligibility, `bp` cookie keying, `Cache-Control`, `Surrogate-Key`, ETag/304, and purge on guest revocation.
- Dev headers `X-Cache` and `X-Cache-Key`, and a latency benchmark on seeded data.
- Records the Astro adapter decision in ADR 0008.

## Capabilities

### New Capabilities
- `page-rendering`: how user-app pages are composed from themes, view models and islands, and the safety rules for templates.
- `caching`: what may be cached, for whom, how it is invalidated, and the freshness guarantees.

### Modified Capabilities
- None.

## Impact

- `packages/templates`, `packages/cache`, `packages/ui/islands`, user-app, user-api, the CDN mock. Updates ADR 0008 status after the spike.
