# Tasks

## 1. Model and registry

- [x] 1.1 Migrations for groups (display attributes, ordering), `member_groups` with primary flag, `group_settings`, `masks`, `group_masks`, `forum_permissions(forum, mask, action bits, inherits)`, and `moderators(forum, member|group, powers, this_forum_only)`; verify with integration tests
- [x] 1.2 Implement the settings/ACP permission registry with merge rules and migrate the interim ACP flags from change `staff-console-shell`; unit tests for each merge rule
- [x] 1.3 Fold password unlocks into the effective `read` bit in `CapabilityView` (marking unlock-dependent responses not CDN-cacheable), and add `announcementAudience(viewer)`; unit tests, and a variant test that an unlocked viewer never shares a variant with a locked one
- [x] 1.4 Implement `core.has_mod_power(member_id, forum_id, power)` in SQL (group super-moderator setting, forum and inherited moderator assignments, bans), granted only to `pii_owner`, with a property test proving it agrees with `can()` across seeded members and fixture trees

## 2. Evaluation

- [x] 2.1 Implement snapshot compilation (group, member and session layers; ancestor AND) and `can()`, with property tests against a reference implementation over random trees
- [x] 2.2 Implement the capability accessor with dependency tracking and `visibilityKey(deps)`, with unit tests for the undeclared-bit scenario
- [x] 2.3 Implement snapshot caching with `perm` tag invalidation and the 1 s backstop; integration test for the revoke-read scenario timing
- [x] 2.4 Implement password unlocks (session grants, throttling) with integration tests for unlock, session end and throttling
- [x] 2.5 Add the architecture test that fails when content queries bypass permission-filtered repositories, and verify it catches a planted bypass

## 3. Promotion

- [x] 3.1 Implement promotion rules (storage, ordered evaluation, worker job with row lock, nightly schedule) with integration tests for the post-count and concurrency scenarios

## 4. Staff screens

- [x] 4.1 Groups list and editor (create/rename/reorder/delete with replacement) with permission-denial tests and E2E at 360/1440
- [x] 4.2 Group settings sections and the cross-group matrix view, with E2E for editing a cell
- [x] 4.3 Masks editor and the forum × mask matrix editor (bulk toggles, inheritance indicators; enabled when forums exist), with E2E for a bulk toggle
- [x] 4.4 Member group management (primary/secondary, logged, session rotation) with integration tests
- [x] 4.5 Moderator assignment editor (member or group, powers, scope), with tests for the limited-moderator and this-forum-only scenarios
- [x] 4.6 Promotion rules editor, with an E2E test

## 5. Strings and seed

- [x] 5.1 Add en/es/fr strings for every registry entry label and staff screen; verify completeness
- [x] 5.2 Seed groups (Guests, Members, Regulars, VIP, Moderators, Super Moderators, Administrators, Banned), masks, promotion rules and moderator assignments matching the darkauth-mock profiles; verify after `docker compose up --watch`
