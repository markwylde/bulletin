# Tasks

## 1. Moderation queue

- [ ] 1.1 Add visibility and hold_reason handling to topics/posts, `needsApproval()` with exhaustive unit tests, and the board/forum/group settings for approval (new-member N off by default)
- [ ] 1.2 Held-content visibility (author-only marker, see-unapproved for moderators, excluded from counters, lists, search and feeds) with the cache variant harness; integration tests
- [ ] 1.3 Approval queue UI (user-app moderator view and staff-app section) with bulk approve/reject, notifications and live counts; tests including permission denial; E2E at 360 and 1440

## 2. Reports

- [ ] 2.1 Migrations and API for reports (post, member, PM; grouping; no duplicates while open), with integration tests
- [ ] 2.2 Report centre (scoped by moderated forums and report permissions, status, assignee, comments) with permission-denial tests; E2E
- [ ] 2.3 PM report access (reported message plus 5 prior, logged) with tests proving no other PM content is reachable
- [ ] 2.4 Outcome notifications to reporters, with an integration test

## 3. Topic moderation

- [ ] 3.1 Merge, split, move (with stubs) and copy mutations with locking, renumbering and declared tags; integration tests for each scenario, and cache invalidation tests for affected pages
- [ ] 3.2 Bulk actions in forum and topic views, with integration tests and E2E at 360
- [ ] 3.3 Multi-moderation definitions (staff app) and application (user app), with tests for the mark-solved scenario and permission denial

## 4. Warnings

- [ ] 4.1 Warning reasons, thresholds, and issue/revoke with notifications; integration tests
- [ ] 4.2 Points calculation, threshold actions (member_restrictions feeding settings merge), the expiry job and acknowledgement gate; tests for the suspension, expiry and acknowledgement scenarios
- [ ] 4.3 Warning history views (member without staff notes, moderator full), with permission-denial tests

## 5. Filters

- [ ] 5.1 Bad-word filter (replace/block, whole-word, all content types) as a write-pipeline stage, with unit tests and a staff manager
- [ ] 5.2 Link limits and anti-spam rules (duplicate, rate, domain blocklist) with group exemptions, as pipeline stages holding content; integration tests for each scenario

## 6. Bans and IPs

- [ ] 6.1 Member bans (Banned group, timed restore job, ban notice), with integration tests
- [ ] 6.2 IP capture via write-only definer functions, and IP/CIDR bans with expiry and middleware checks; tests for the CIDR and expiry scenarios
- [ ] 6.3 Audited IP lookups (two-transaction grant, step-up, view-IPs power, retention-expired message), with tests proving the audit row commits before data is returned, and a denial test

## 7. Moderation log

- [ ] 7.1 Append-only moderation log (INSERT/SELECT grants only), wired into every moderation mutation, with scoped viewing; tests that every action in the spec list writes an entry, and that UPDATE/DELETE are denied

## 8. Strings and seed

- [ ] 8.1 Add en/es/fr strings for all moderation UI, notifications and reasons; verify completeness
- [ ] 8.2 Seed held posts from the new-member profile, open and resolved reports (including a PM report), warnings with thresholds reached for the warned profile, a banned member, IP bans, filter words, multi-mod actions and log entries; verify after `docker compose up --watch`
