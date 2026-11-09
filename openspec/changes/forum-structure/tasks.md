# Tasks

## 1. Model

- [ ] 1.1 Migrations for forums (ltree path, type, settings, slug, counters), prefixes, forum_prefixes, slug_history, announcements, announcement_targets and dismissals; integration tests for moves and cycle rejection
- [ ] 1.2 Implement the `ForumTree` provider for the permission compiler, and enable the matrix editor from change 6; integration test that the ancestor rule applies to real forums

## 2. User app

- [ ] 2.1 Board index route (categories, forums, sub-forum links, counts, latest readable post) with permission-filtered queries; integration tests with permission-denial cases; E2E at all viewports
- [ ] 2.2 Forum route shell (breadcrumbs, rules box with remembered collapse, prefix filter, announcements, moderators list, password prompt) with tests for each scenario
- [ ] 2.3 Redirect forums with click counting, and slug redirects (301), with integration tests

## 3. Staff screens

- [ ] 3.1 Forum tree manager (create, drag reorder/reparent, delete with move-or-delete choice), with tests for each scenario including permission denial; E2E at 360/1440
- [ ] 3.2 Forum settings form (description, rules, password, prefixes, show moderators, language), with integration tests
- [ ] 3.3 Prefix manager (labels per locale, colour, group restriction), with tests for the required-prefix rule
- [ ] 3.4 Announcements manager (scope, groups, schedule, dismissible), with tests for scheduling, targeting and dismissal

## 4. Strings and seed

- [ ] 4.1 Add en/es/fr strings for the index, forum page, prefixes, announcements and staff screens; verify completeness
- [ ] 4.2 Seed ~15 forums across 4 categories with 3 levels of nesting, one redirect forum, one password forum, one staff-only forum, prefixes, and global plus forum announcements; verify after `docker compose up --watch`
