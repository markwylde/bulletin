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
- **Offline board**: while the board is offline, feeds and sitemaps answer `503` with
  `Retry-After` and `no-store` to everyone (they are Guests documents), unless Guests hold
  `board.view_offline` via `can()`. Every feed and sitemap carries the `board` tag, so going
  offline invalidates cached copies. `robots.txt` keeps being served.
- **Sitemap pagination**: 10,000 URLs per file, keyset-paginated by topic ID.
  `lastmod` = `last_post_at`.
- **Excerpts**: the first 300 characters of the first post's `body_text` (quote-free).
- **Metadata**: the view model provides `seo { title, description, canonical, og, jsonLd,
  hreflang[] }`. The default theme's `head` template renders it (title, description, robots,
  canonical, `hreflang` links, OpenGraph and Twitter tags) from `{ seo, boardName }` with
  absolute URLs; themes can override presentation, but the required-meta check ensures the
  canonical and robots tags exist:
  - at save/install time the `head` template must contain a title, a robots meta and a
    canonical link, and only `title`, `meta` (no `http-equiv`/`charset`) and
    `link rel="canonical|alternate"` elements;
  - at render time, after autoescaping and the theme sanitiser, anything else is removed,
    robots/canonical/`og:url`/`hreflang` tags that disagree with the trusted values are
    dropped, and missing title, robots, canonical and alternates are added from the view
    model. A failed or missing template falls back to the trusted tags.
  The head renders per response (not in the cached body), because canonical and `hreflang`
  depend on the request origin and `?lang=`. JSON-LD stays app markup with the CSP nonce,
  since themes cannot emit scripts (ADR 0008).
- **Locale variants**: `hreflang` alternates are `?lang=<locale>` URLs. For guests, `?lang=` is
  a server locale source ahead of `bp` and the board default (the client locale bootstrap
  already honoured it), so each alternate renders its own locale. It is part of the URL, so the CDN key
  (URL + `bp`) and the origin variant key (which includes the locale) keep variants apart; it
  never rewrites `bp` and never varies by member. The board default locale's alternate and
  `x-default` are the clean URL; a non-default `?lang=` page is its own canonical.

## Privacy checklist (ADR 0012)

This change stores no new personal data. It re-publishes personal content that guests can
already read, in machine-readable form, to crawlers and feed readers. `robots.txt` (column
`core.board_settings.robots_txt`) is board configuration, not personal data.

| Data published | Where | Class |
|---|---|---|
| Member display name | feed item author (`dc:creator`, Atom `author`), topic JSON-LD author, profile title and `Person` JSON-LD, profile URL slug in member sitemaps | personal content |
| Profile "about" text or custom title | profile meta/OpenGraph description and JSON-LD | personal content |
| First-post text (300 quote-free characters) | feed excerpts, topic meta description | personal content |
| Generated feeds, sitemaps and page heads | CDN entries | derived |

- **Purpose**: making content that is already public to guests discoverable by search engines
  and followable in feed readers (the board's public posting purpose; no new purpose).
- **Access permission**: Guests only. Every feed and sitemap evaluates the Guests snapshot via
  `can()`, regardless of who asks; password forums, member-only forums and unapproved or
  soft-deleted content never appear. Member sitemaps list only active, non-service members
  with a display name who have not chosen to hide from the member list. Profiles that are not
  public, and pages guests cannot see, are `noindex`.
- **Retention**: nothing is stored at the origin; documents are generated on request. CDN
  copies live at most `s-maxage=15` + `stale-while-revalidate=15` = **30 s** (ADR 0006). Copies
  already taken by third-party crawlers and feed readers are outside the board's control and are
  not covered by erasure; the admin-authored privacy policy should say so.
- **Export**: nothing new to export. The underlying posts, profile and display name are in the
  member's existing export.
- **Erasure**: anonymisation changes the display name, clears the profile text, sets
  `hide_from_member_list` and the `erased` state, so regenerated feeds show the anonymised
  name and sitemaps drop the profile URL. Feeds carry the `member:{id}` tag of every listed
  author and member sitemaps carry `member_directory`; the erasure job bumps and CDN-purges
  both tags when it anonymises the member, so cached copies are invalidated immediately rather
  than waiting for the 30 s expiry. Other cached pages that embed the name (topic heads) are
  re-rendered via their topic tags and expire from the CDN within the same 30 s window.
  Tested in `tests/integration/seo-feeds.test.ts` (erasure scenario).

## Risks / Trade-offs

- [Large boards' sitemap generation cost] → served from cache; regenerated per tag invalidation, not per request.

## Feature flags (ADR 0010)

`feeds` (RSS/Atom). Sitemaps and canonical URLs are core.

Gating: server routes use `requireFlag(key)` (404 when off), templates use `{% if flags.<key> %}`, and islands use `useFlag(key)`. Flags marked `affectsRender` are part of the cache variant (ADR 0006, 0010).
