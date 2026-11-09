# Proposal

## Why

ADR 0013 requires English, Spanish and French from day one, with no hard-coded strings.
Every later change adds strings, so the catalog system, locale resolution and CI checks must
exist first.

## What Changes

- ICU MessageFormat catalogs per app and package, with en/es/fr.
- Locale resolution for members (preference) and guests (`bp` cookie), and a client-side suggestion banner based on `Accept-Language`.
- Template, React and server (email/push) translation helpers, with `Intl` formatting.
- Admin string overrides stored in the DB, cached per locale.
- Validation of runtime catalogs (themes, plugins, overrides) at save/install time.
- CI checks for missing and unused keys, plus a lint rule against hard-coded UI strings.

## Capabilities

### New Capabilities
- `i18n`: supported locales, locale resolution, message formatting, admin overrides and catalog validation.

### Modified Capabilities
- None.

## Impact

- `packages/i18n`, both apps, the emails pipeline (later), and the staff app (string editor added in change `staff-console-shell`).
