# Design

## Context

ADR 0013 sets the rules; ADR 0006 requires the locale to be part of the cache variant, and
guest locale to be deterministic from `bp`.

## Goals / Non-Goals

**Goals:** one formatter used by Liquid templates, React and server-side messages; a fast
lookup path with overrides layered in.

**Non-Goals:** right-to-left languages; localised URLs; machine translation.

## Decisions

- **Formatter**: `intl-messageformat` (ICU, small, well tested) wrapped in `packages/i18n`.
  Compiled messages are cached per `(locale, key)`. *Alternative:* a hand-rolled formatter.
  Rejected because ICU plural rules are subtle.
- **Catalog layout**: `apps/<app>/i18n/<locale>.json` and `packages/<pkg>/i18n/<locale>.json`
  with namespaced keys (`topic.reply.button`). A build step merges them into one catalog per
  app per locale.
- **Override layering**: lookup order is admin override (DB) → theme override → plugin
  catalog (plugin keys only) → shipped catalog → `en` shipped. Overrides are cached in-process
  under tag `i18n:{locale}` (ADR 0006).
- **`bp` cookie**: format `<locale>.<themeId>.<scheme>`, not HttpOnly (the client-side switcher
  sets it), `SameSite=Lax`, 1-year expiry. Unknown values fall back to defaults. This change
  defines the locale part; theme and scheme are filled in by later changes, with defaults until then.
- **Lint**: a Biome plugin or custom script flags JSX text nodes and string literals passed to
  known UI props (`title`, `placeholder`, `aria-label`).

## Risks / Trade-offs

- [Catalog drift across three languages] → CI completeness check; the seed includes es/fr content so drift is visible.
- [Overrides make strings unpredictable for support] → the staff app lists all active overrides, with one-click revert.

## Feature flags (ADR 0010)

None: localisation is core to every page, exempt under ADR 0010.

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| String overrides (`core.string_overrides.updated_by`) | Personal content (staff identity) | accountability | life of the override | staff with `acp.strings` | included for that staff member | `updated_by` set to null |
