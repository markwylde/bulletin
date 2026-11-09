# Tasks

## 1. Shell

- [x] 1.1 Build the staff app layout (responsive nav, header, colour mode switch, locale switcher) and section registry with route guards; E2E at 360/390/1440 for nav and mode switching
- [x] 1.2 Implement the staff-api permission guard used by every route, with an integration test that every registered route rejects a member without `acp.access` (403)
- [x] 1.3 Dashboard widget registry (permission-gated widgets, data endpoints checked server-side) with member stats, admin log and system health widgets; tests for the moderator scenario
- [x] 1.4 Implement `core.has_acp(member_id, permission)` in SQL, mirroring the ACP permission check for `pii` definer functions, with a property test that it agrees with the TypeScript check

## 2. Building blocks

- [x] 2.1 Implement the data table (sorting, pagination, bulk actions, mobile card view) with component tests and an E2E check at 360 px
- [ ] 2.2 Implement the declarative form renderer (all listed field types, validation, conditional visibility, i18n labels) with unit tests per field type
- [ ] 2.3 Implement the confirmation dialog and toast components, with component tests

## 3. Sections

- [ ] 3.1 Board settings (name, description, default locale, offline mode and message) with `board.view_offline` enforcement in the user app; integration tests including permission denial, and E2E for offline mode
- [ ] 3.2 String override editor (search keys, edit per locale, revert, list of active overrides) using `i18n-foundation` validation; E2E for override and revert
- [ ] 3.3 Admin log table, the write helper used by all staff writes, and the filtered log view; integration test that a settings change is logged
- [ ] 3.4 Dashboard with stats, health and recent log panels gated per permission; tests that a moderator does not receive admin-only panels

## 4. Strings and seed

- [ ] 4.1 Add en/es/fr strings for the shell, sections and form errors; verify completeness
- [ ] 4.2 Seed board settings and a few admin log entries, and verify the dashboard shows data after `docker compose up --watch`
