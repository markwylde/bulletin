# Tasks

## 1. Default theme

- [ ] 1.1 Complete the default theme templates for every user-app route built so far, with light/dark tokens; E2E visual check at 360/390/1440 in both schemes, and the contrast check passing
- [ ] 1.2 Implement repo-to-DB sync of the default theme by hash, with an integration test

## 2. Management

- [ ] 2.1 Theme storage migrations, child theme creation and inheritance resolution, with integration tests for the parent-update scenario
- [ ] 2.2 Template editor (parent view, diff, validation errors, versions, restore, revert to parent) with tests including permission denial; E2E at 1440 and 360
- [ ] 2.3 Token form and custom CSS with the CSS filter, with tests for the external-import scenario
- [ ] 2.4 Asset manager and theme string overrides, with integration tests
- [ ] 2.5 Session preview, with a cache variant test proving other viewers are unaffected

## 3. Distribution

- [ ] 3.1 Bundle export/import with Ed25519 signatures, with tests for the unsigned-bundle scenario
- [ ] 3.2 Marketplace theme install via `mocks/marketplace`, running all checks including the WebView smoke test in a worker; tests for the failing-check scenario

## 4. Availability and choice

- [ ] 4.1 Allowed groups and per-group default theme, with tests for the VIP and lost-access scenarios
- [ ] 4.2 Member and guest chooser (footer and settings; theme plus scheme; `bp` cookie), with E2E at 360

## 5. Strings and seed

- [ ] 5.1 Add en/es/fr strings for the theme manager and chooser; verify completeness
- [ ] 5.2 Seed a second theme (child of default, distinct tokens and one overridden template), a VIP-only theme, and a marketplace theme package; verify after `docker compose up --watch`

## 6. Feature flag

- [ ] 6.1 Register `theme_chooser` with `defineFlag` (off in production defaults, on in the seed), gate routes with `requireFlag`, templates with `{% if flags.<key> %}` and islands with `useFlag`; tests that each surface is absent (404 or not rendered) when off, and a cache variant test for the flag toggle
