# Tasks

## 1. Sitemaps and feeds

- [ ] 1.1 Sitemap index and paginated sitemaps using the Guests snapshot, with tests for the staff-forum exclusion
- [ ] 1.2 RSS and Atom feeds (board and per forum, guest-visible, quote-free excerpts), with tests for the forum and private-forum scenarios
- [ ] 1.3 CDN caching and tags for sitemaps and feeds, with a test for the topic-made-private scenario via the CDN mock

## 2. Metadata

- [ ] 2.1 View-model `seo` fields for every public route, and head templates in the default theme (title, description, canonical, OG/Twitter, JSON-LD, hreflang); tests for the canonical scenario
- [ ] 2.2 `noindex` rules and the admin-editable `robots.txt`, with tests for the search-page scenario and permission denial on the editor

## 3. Strings and seed

- [ ] 3.1 Add en/es/fr strings for feed titles and meta descriptions; verify completeness
- [ ] 3.2 Verify the seeded board produces valid sitemaps and feeds (XML validation) after `docker compose up --watch`

## 4. Feature flag

- [ ] 4.1 Register `feeds` with `defineFlag` (off in production defaults, on in the seed), gate routes with `requireFlag`, templates with `{% if flags.<key> %}` and islands with `useFlag`; tests that each surface is absent (404 or not rendered) when off, and a cache variant test for the flag toggle
