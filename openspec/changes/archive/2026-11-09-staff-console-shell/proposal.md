# Proposal

## Why

Every admin and moderator feature needs a home: the staff app (Admin/Mod control panel).
ADR 0008 says it is not themeable but has light and dark modes; ADR 0014 says it must work
on mobile; ADR 0009 says plugins extend it only through declared forms.

## What Changes

- Staff app shell: navigation, dashboard, light/dark/system mode, responsive layout, and en/es/fr.
- ACP permission gating (`acp.access` plus per-section permissions) for navigation and every staff-api route.
- Board settings section (name, default locale, offline mode and message).
- String override editor (uses `i18n-foundation`).
- Reusable admin UI building blocks: data table with mobile card view, form renderer from a declarative schema (later reused for plugin settings), confirmation dialogs, and audit trail viewer.
- Admin action log for every staff write.

## Capabilities

### New Capabilities
- `staff-console`: staff app access, navigation, board settings, admin audit log, and consistent admin UI.

### Modified Capabilities
- None.

## Impact

- `apps/staff-app`, `apps/staff-api`, `packages/ui`. Adds `core.admin_log`.
