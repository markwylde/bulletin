# Proposal

## Why

Admins must fully customise the user app's look (IPB skins), install themes from the
marketplace, and control which groups can use which themes. Members choose among allowed
themes and light/dark/system. The engine exists (change `rendering-and-caching`); this change adds management.

## What Changes

- The complete default theme covering every user-app route, with light and dark variants.
- Theme management in the staff app: list, create child theme, edit templates (with diff and revert), edit CSS tokens and custom CSS, manage assets and string overrides, preview, activate.
- Theme import/export as a signed bundle, and marketplace install for themes.
- Theme availability per group and default theme per group.
- Member theme and colour-scheme chooser (also via the `bp` cookie for guests).
- Install-time checks: required islands, sanitiser, CSS filter, contrast and responsive smoke tests.

## Capabilities

### New Capabilities
- `themes`: managing, installing, assigning and choosing themes for the user app.

### Modified Capabilities
- None.

## Impact

- staff-app theme section, staff-api, `packages/templates` (bundle format), the marketplace mock (theme packages), user-app theme chooser.
