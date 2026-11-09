# Design

## Context

ADR 0008; the engine, validation and caching exist from change `rendering-and-caching`.

## Goals / Non-Goals

**Goals:** a safe, versioned theme lifecycle, and a complete default theme.

**Non-Goals:** a visual drag-and-drop page builder.

## Decisions

- **Storage**:
  - `themes(id, parent_id, name, version, allowed_groups, default_for_groups, source
    enum(core, marketplace, upload, custom), signature)`
  - `theme_templates(theme_id, name, body, version, updated_by)` and `theme_template_versions`
  - `theme_tokens(theme_id, scheme, tokens jsonb)`, `theme_css`, `theme_assets` (S3 keys),
    `theme_strings`
- **Default theme source**: lives in `packages/templates/themes/default` (files). On startup,
  the DB copy is synced when its repo hash changes. Admins can't edit it directly; they make a
  child theme.
- **Bundle format**: a tar of `theme.json` plus templates, CSS, tokens, assets and strings,
  with a detached Ed25519 signature. The marketplace public key is configured, and the dev key
  is used for `mocks/marketplace`.
- **Checks at install/save**:
  - template validation and the required-islands check (change `rendering-and-caching`)
  - CSS filter (`lightningcss` parse; reject imports and external `url()`)
  - contrast check of token pairs (computed, WCAG AA)
  - responsive smoke render at 360 px of 5 key routes via `Bun.WebView` in a worker (for
    marketplace and upload installs)
- **Preview**: a session-scoped `preview_theme_id` changes the variant key (`themeId@version`),
  so the cache stays correct.
- **Chooser**: the allowed list is computed from group snapshots. The member choice is stored
  in `member_prefs`; guests use `bp`.

## Risks / Trade-offs

- [WebView smoke test in a worker is heavy] → run only on install, not on every template save.

## Feature flags (ADR 0010)

`theme_chooser` (members picking a theme). Admin theme management is staff-only tooling, exempt under ADR 0010.

Gating: server routes use `requireFlag(key)` (404 when off), templates use `{% if flags.<key> %}`, and islands use `useFlag(key)`. Flags marked `affectsRender` are part of the cache variant (ADR 0006, 0010).
