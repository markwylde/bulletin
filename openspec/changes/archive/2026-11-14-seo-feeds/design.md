# Design

## Context

Uses the Guests permission snapshot and CDN caching rules (ADR 0006).

## Goals / Non-Goals

**Goals:** correct, cheap sitemaps and feeds at 1M posts.

**Non-Goals:** per-member private feeds (could come later with tokens).

## Decisions

- **Guest-only queries**: sitemaps and feeds always evaluate with the Guests snapshot,
  regardless of the requester (there is no member variant). Routes are `cdnCacheable` and
  tagged with the forums they include.
- **Sitemap pagination**: 10,000 URLs per file, keyset-paginated by topic ID.
  `lastmod` = `last_post_at`.
- **Excerpts**: the first 300 characters of the first post's `body_text` (quote-free).
- **Metadata**: the view model provides `seo { title, description, canonical, og, jsonLd,
  hreflang[] }`. Default theme head templates render it; themes can override presentation,
  but the required-meta check ensures the canonical and robots tags exist.

## Risks / Trade-offs

- [Large boards' sitemap generation cost] → served from cache; regenerated per tag invalidation, not per request.

## Feature flags (ADR 0010)

`feeds` (RSS/Atom). Sitemaps and canonical URLs are core.

Gating: server routes use `requireFlag(key)` (404 when off), templates use `{% if flags.<key> %}`, and islands use `useFlag(key)`. Flags marked `affectsRender` are part of the cache variant (ADR 0006, 0010).
