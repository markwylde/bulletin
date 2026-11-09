# Tasks

## 1. Profiles and fields

- [ ] 1.1 Migrations for profile fields, field groups, field values, about, privacy options and signature columns; integration tests
- [ ] 1.2 Profile page view model and template (stats, fields by visibility class, badges, recent readable posts) with the cache variant harness applied; tests for the permission-filtered recent posts and the staff-only field; E2E at all viewports
- [ ] 1.3 Profile editing (about, fields with required/editability, privacy options) and staff edit with logging; integration tests including permission denial
- [ ] 1.4 Staff custom field manager (types, labels per locale, group view/edit), with tests

## 2. Signatures

- [ ] 2.1 Signature editor with group limits, the signature fragment under posts, and "hide signatures" via the overlay; tests for the too-many-links and hide scenarios

## 3. Relationships

- [ ] 3.1 Ignore list (unignorable staff, collapsed posts via overlay, no-reveal), with tests for each scenario
- [ ] 3.2 Hook the ignore check into the notification recipient filter, with a test that an ignored member's mention delivers no notification
- [ ] 3.3 Friends (request, accept/decline, remove, list, hide list, notifications), with integration tests and an E2E at 360

## 4. Directory

- [ ] 4.1 Member list (search, filters, sort, opt-out exclusion, `members.view_list`), with tests including permission denial; E2E at 360 (card layout)
- [ ] 4.2 Presence tracking, the who's-online summary and full list with permission-filtered locations, with tests for the hidden-location scenario
- [ ] 4.3 Board statistics and record online, with integration tests
- [ ] 4.4 Leaderboards job and page (guest-visible content only), plus today's top poster; tests for the private-content exclusion

## 5. Ranks and badges

- [ ] 5.1 Ranks manager and rank display, plus custom titles with group permission and bad-word filter hook; tests
- [ ] 5.2 Badge definitions, manual award/revoke (logged), featured badges; tests including permission denial
- [ ] 5.3 Badge rule evaluator (event subscriber and nightly sweep, at-most-once), with tests for the auto-award scenario

## 6. Strings and seed

- [ ] 6.1 Add en/es/fr strings for profiles, fields, signatures, relationships, directory, ranks and badges; verify completeness
- [ ] 6.2 Seed custom fields (including a staff-only field), signatures, ranks, badges (manual and automatic) and awards, ignores, friendships, presence and leaderboard data; verify after `docker compose up --watch`
