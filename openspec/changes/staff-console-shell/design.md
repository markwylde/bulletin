# Design

## Context

The staff app is a Vite + React SPA on its own origin (ADR 0018), talking to staff-api.
At this point the permission registry from `groups-permissions` does not exist yet, so ACP
permissions start as a minimal set on the built-in groups. Change `groups-permissions` migrates them into the
registry.

## Goals / Non-Goals

**Goals:** a shell and building blocks that every later staff feature plugs into.

**Non-Goals:** any domain section beyond board settings, string overrides and the log.

## Decisions

- **Routing and data**: React Router plus TanStack Query. *Alternative:* a custom fetch layer.
  Rejected; caching and retries for free are worth the dependency (justified in its PR).
- **Section registry**: each staff section registers `{ id, path, navGroup, permission, icon,
  labelKey }`. Navigation and route guards derive from it. Plugin pages (change
  `plugin-platform`) register here with fixed page types.
- **Form renderer**: a JSON-schema-based DSL in `packages/ui/forms`, used for core settings
  first so that plugins get a proven component. Field types are listed in the spec.
- **Styling**: CSS custom properties for light/dark, and the same tokens as the default user
  theme, but compiled in (not themeable). The colour mode is stored in
  `core.member_prefs.staff_scheme`.
- **Admin log**: `core.admin_log(id, actor_member_id, action, target_type, target_id,
  summary jsonb, created_at)`, written in the same transaction as the change by a staff-api
  helper that every write route uses.

## Risks / Trade-offs

- [Permission bootstrap before the registry exists] → a single migration in change `groups-permissions` maps the interim flags; tests guard the mapping.

## Feature flags (ADR 0010)

None: staff-only tooling, exempt under ADR 0010.

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| Staff preferences (`core.member_prefs.staff_scheme`) | Personal content | staff UI | life of account | the member | included | deleted |
| Admin log (`core.admin_log`) | Security record | accountability | 2 years | staff with `acp.log` | entries where the member is the actor | actor anonymised |
