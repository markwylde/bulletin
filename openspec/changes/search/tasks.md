# Tasks

## 1. Index

- [x] 1.1 Migrations for `lang` and the generated `tsv`/`tsv_simple` columns on topics and posts, GIN and partial indexes, and `pg_trgm` on display names; integration test for immediate indexing
- [x] 1.2 Forum language change rebuild job, with an integration test

## 2. Query

- [x] 2.1 Search service (parsing, dual-config query, ranking, filters, sorting, cap) with permission and visibility filtering; tests for stemming, phrase/exclusion, the hidden-forum, deleted-after-indexing and quote scenarios
- [x] 2.2 Safe snippets with sentinel highlighting, with a unit test for the markup-in-snippet scenario
- [x] 2.3 Member search with trigram ranking and opt-out respect, with tests
- [x] 2.4 Search flood control from group settings, with a test

## 3. UI

- [x] 3.1 Search page (filters, sort, results, pagination) and the quick-search box, in default theme templates; E2E at 360 and 1440
- [x] 3.2 "Content by member" and "new content since last visit" views, with integration tests

## 4. Performance, strings and seed

- [x] 4.1 Benchmark search on the `SEED_SIZE=large` dataset (p95 < 300 ms for common queries), and record the results
- [x] 4.2 Add en/es/fr strings for search UI and errors; verify completeness
- [x] 4.3 Make sure seeded content in all three languages is searchable, and verify a sample query per language after `docker compose up --watch`

## 5. Route contracts

- [ ] 5.1 View-model contracts for the search, content-by-member and new-content routes (`private, no-store` where results depend on the viewer) registered with the harness

## 6. Feature flag

- [ ] 6.1 Register `search` with `defineFlag` (off in production defaults, on in the seed), gate routes with `requireFlag`, templates with `{% if flags.<key> %}` and islands with `useFlag`; tests that each surface is absent (404 or not rendered) when off, and a cache variant test for the flag toggle
