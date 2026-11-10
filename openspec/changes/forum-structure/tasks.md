# Tasks

## 1. Model

- [x] 1.1 Migrations for forums (ltree path, type, settings, slug, counters), prefixes, forum_prefixes, slug_history, announcements, announcement_targets and dismissals; integration tests for moves and cycle rejection
- [x] 1.2 Implement the `ForumTree` provider for the permission compiler, and enable the matrix editor from change `groups-permissions`; integration test that the ancestor rule applies to real forums

## 2. User app

- [x] 2.1 Board index route as default-theme templates plus a view-model contract (categories, forums, sub-forum links, counts, latest readable post) with permission-filtered queries; integration tests with permission-denial cases; register it with the cache variant harness and the latency benchmark; E2E at all viewports
- [x] 2.2 Forum route templates and view-model contract (breadcrumbs, rules box with remembered collapse, prefix filter, announcements, moderators list, password prompt) with tests for each scenario; register it with the variant harness (password unlock and member mod assignment variants)
- [x] 2.3 Redirect forums with click counting (an UNLOGGED buffer flushed by a worker, per ADR 0006 read-path writes, never invalidating caches), and slug redirects (301), with integration tests
- [x] 2.4 Mutation tag declarations for tree moves, forum settings and announcements; integration tests that each change invalidates the index and affected forum pages and nothing leaks across variants
- [x] 2.5 Announcement blocks keyed by the announcement audience class, with TTL capped at the next transition and the minute transition worker; variant test for the targeted-announcement scenario and an integration test for scheduled expiry of a cached page

## 3. Staff screens

- [x] 3.1 Forum tree manager (create, drag reorder/reparent, delete with move-or-delete choice), with tests for each scenario including permission denial; E2E at 360/1440
- [x] 3.2 Forum settings form (description, rules, password, prefixes, show moderators, language), with integration tests
- [x] 3.3 Prefix manager (labels per locale, colour, group restriction), with tests for the required-prefix rule
- [x] 3.4 Announcements manager (scope, groups, schedule, dismissible), with tests for scheduling, targeting and dismissal

## 4. Strings and seed

- [ ] 4.1 Add en/es/fr strings for the index, forum page, prefixes, announcements and staff screens; verify completeness
- [ ] 4.2 Seed ~15 forums across 4 categories with 3 levels of nesting, one redirect forum, one password forum, one staff-only forum, prefixes, and global plus forum announcements; verify after `docker compose up --watch`

## 5. Feature flag

- [ ] 5.1 Register `announcements` with `defineFlag` (off in production defaults, on in the seed), gate the staff screen and announcement blocks; tests that announcements are absent when off, and a cache variant test for the flag toggle
