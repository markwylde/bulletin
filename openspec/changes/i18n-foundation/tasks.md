# Tasks

## 1. Core library

- [ ] 1.1 Implement `packages/i18n` (catalog loading, ICU formatting, plural/select, `Intl` date/number/relative helpers) with unit tests for plurals in en/es/fr
- [ ] 1.2 Implement the catalog build/merge step and the completeness/unused-key checker, wired into `bun run check`; verify it fails on a planted missing key
- [ ] 1.3 Add the hard-coded-string lint rule and verify it flags a planted JSX literal

## 2. Locale resolution

- [ ] 2.1 Implement member/guest locale resolution and the `bp` cookie codec, with unit tests for each fallback path
- [ ] 2.2 Add `core.board_settings.default_locale` (migration) with integration tests; member locale lands in `identity-sessions`

## 3. Overrides and runtime validation

- [ ] 3.1 Add `core.string_overrides(locale, key, value, updated_by, updated_at)` and the override layer with tag invalidation; integration test that an override applies and a revert restores it
- [ ] 3.2 Implement runtime catalog validation (ICU parse, placeholder match, completeness report) with unit tests for the mismatch and fallback scenarios

## 4. Bindings

- [ ] 4.1 Provide `useT()` for React and a server `t()` for emails and push; verify with unit tests
- [ ] 4.2 Register a `{% t %}` tag for the template engine (consumed by change `rendering-and-caching`) with a unit test

## 5. Strings and seed

- [ ] 5.1 Move the foundation placeholder strings into real en/es/fr catalogs and verify completeness passes
- [ ] 5.2 Seed the board default locale, and verify with an integration test that the resolver and formatter use it after `docker compose up --watch`
