# Tasks

## 1. Moderation queue

- [x] 1.1 Add visibility and hold_reason handling to topics/posts, `needsApproval()` with exhaustive unit tests, and the board/forum/group settings for approval (new-member N off by default)
- [x] 1.2 Held-content visibility (see-unapproved for moderators in shared fragments; the author's own held posts and topics delivered via the private overlay; excluded from counters, lists, search and feeds) with the cache variant harness; integration tests including the two-authors scenario
- [x] 1.3 Approval queue UI (user-app moderator view and staff-app section) with bulk approve/reject, notifications and live counts; tests including permission denial; E2E at 360 and 1440
- [x] 1.4 Register the pending moderation counts dashboard widget for moderators, with a permission test

## 2. Reports

- [x] 2.1 Migrations and API for reports (post, member, PM; grouping; no duplicates while open), with integration tests
- [x] 2.2 Report centre (scoped by moderated forums and report permissions, status, assignee, comments) with permission-denial tests; E2E
- [x] 2.3 PM report access (reported message plus 5 prior, logged) with tests proving no other PM content is reachable; insert `conversation_message_holds` for those messages when the report opens and release them on close, with a test that the last participant leaving keeps the held messages and attachments until the report closes
- [x] 2.4 Outcome notifications to reporters, with an integration test

## 3. Topic moderation

- [x] 3.1 Merge, split and move (with stubs) mutations with locking, renumbering and declared tags; integration tests for each scenario, and cache invalidation tests for affected pages
- [x] 3.2 Bulk actions in forum and topic views, with integration tests and E2E at 360
- [x] 3.3 Multi-moderation definitions (staff app) and application (user app), with tests for the mark-solved scenario and permission denial
- [x] 3.4 Multi-moderation reply steps post as the acting moderator or a designated `is_service` member only; a test that any other author is rejected at definition time

## 4. Warnings

- [x] 4.1 Warning reasons, thresholds, and issue/revoke with notifications; integration tests
- [x] 4.2 Points calculation, threshold actions (member_restrictions feeding settings merge), the expiry job and acknowledgement gate; tests for the suspension, expiry and acknowledgement scenarios
- [x] 4.3 Warning history views (member without staff notes, moderator full), with permission-denial tests

## 5. Filters

- [x] 5.1 Bad-word filter: block as a write-pipeline stage, and replace as the render-time transform list (never mutating source text; list changes bump the filter version and enqueue re-render), across all content types, with a staff manager; tests for the replace, block and new-word-added-later scenarios
- [x] 5.2 Link limits and anti-spam rules (duplicate, rate, domain blocklist) with group exemptions, as pipeline stages holding content; integration tests for each scenario

## 6. Bans and IPs

- [ ] 6.1 Member bans (Banned group, timed restore job, ban notice), with integration tests
- [ ] 6.2 IP capture via the write-only definer function `pii.record_post_ip` (ADR 0012 table), and IP/CIDR bans in `core.ip_bans` checked in the app without reading `pii` with expiry and middleware checks; tests for the CIDR and expiry scenarios
- [ ] 6.3 Audited IP lookups (two-transaction grant, step-up, view-IPs power, retention-expired message) via `pii.read_post_ip`, with tests proving the audit row commits before data is returned, and a denial test
- [ ] 6.4 Reverse IP lookup via `pii.read_members_by_ip` (own audited grant, forum-scoped to the actor's view-IPs forums, 100-row cap), with tests for the forum-scoping scenario, the audit row, and role denial for user_api and workers
- [ ] 6.5 `pii.read_login_ips(grant)` for admins with `members.view_ips` (step-up, audited, in-SQL checks), with permission-denial and audit tests

## 7. Moderation log

- [ ] 7.1 Append-only moderation log (INSERT/SELECT grants only), wired into every moderation mutation, with scoped viewing; tests that every action in the spec list writes an entry, and that UPDATE/DELETE are denied

## 8. Strings and seed

- [ ] 8.1 Add en/es/fr strings for all moderation UI, notifications and reasons; verify completeness
- [ ] 8.2 Seed held posts from the new-member profile, open and resolved reports (including a PM report), warnings with thresholds reached for the warned profile, a banned member, IP bans, filter words, multi-mod actions and log entries; verify after `docker compose up --watch`

## 9. Feature flag

- [ ] 9.1 Register `warnings`, `multimod` with `defineFlag` (off in production defaults, on in the seed), gate routes with `requireFlag`, templates with `{% if flags.<key> %}` and islands with `useFlag`; tests that each surface is absent (404 or not rendered) when off, and a cache variant test for the flag toggle
