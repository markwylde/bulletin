# Tasks

## 1. Inventory and access

- [ ] 1.1 Write `docs/privacy/inventory.md`, add `@personal` comments to all existing personal columns, and build the CI checker; verify it fails on a planted unlisted column
- [ ] 1.2 Add a test sweep proving every app role is denied direct access to every `pii` table, and to functions it has no grant for

## 2. Retention

- [ ] 2.1 Retention settings (staff screen, defaults) and the nightly purge job across `pii` and core categories; integration tests for each category expiring

## 3. Export

- [ ] 3.1 Export request (member settings), job (all sections, plugin `gdpr.export`, attachments), notification/email and the expiring authenticated download; tests for the ready and expired scenarios

## 4. Erasure

- [ ] 4.1 Erasure request and confirmation listing retained categories, with a test for the active-ban scenario
- [ ] 4.2 Erasure job (ordered idempotent steps, plugin `gdpr.erase`, anonymise or delete posts), with tests for both post choices and the plugin scenario, and a test that no restricted data remains

## 5. Staff tools

- [ ] 5.1 Data request queue (status, due dates, overdue highlight, process/reject), with permission-denial tests; E2E at 360
- [ ] 5.2 PII access log viewer (`privacy.audit`) with filters, with permission-denial tests

## 6. Member pages, strings and seed

- [ ] 6.1 Member privacy page (export, erasure, retained-data explanation) and an admin-managed privacy policy page; E2E at all viewports
- [ ] 6.2 Add en/es/fr strings for privacy UI, emails and staff screens; verify completeness
- [ ] 6.3 Seed one completed export, one pending erasure request and PII access log entries; verify after `docker compose up --watch`
