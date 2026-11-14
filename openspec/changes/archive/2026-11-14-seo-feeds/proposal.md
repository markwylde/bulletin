# Proposal

## Why

Public forums depend on search engines and feed readers. You confirmed slug URLs, sitemap.xml
and RSS per forum. Slugs already exist; this change adds sitemaps, feeds, metadata and
canonical URLs.

## What Changes

- `sitemap.xml` index plus paginated sitemaps of guest-readable forums, topics and member profiles.
- RSS 2.0 (and Atom) feeds for the board and per forum, guest-visible content only.
- Page metadata: titles, descriptions, canonical URLs, OpenGraph and Twitter cards, `hreflang` for locale variants, structured data for discussions.
- `robots.txt` managed by admins, and `noindex` for non-public and thin pages.

## Capabilities

### New Capabilities
- `seo-feeds`: discoverability of public content through search engines and feeds.

### Modified Capabilities
- None.

## Impact

- user-app routes (sitemap, feeds, robots), default theme head templates, staff settings, and caching (CDN-cacheable routes).
