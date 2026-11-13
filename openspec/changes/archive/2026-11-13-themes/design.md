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
  - static responsive checks at install (no browser in production images): parse5 layout
    rules, required islands, lightningcss validation and computed WCAG AA contrast of the
    token pairs for both schemes. `Bun.WebView` 360 px smoke renders run only in CI, for
    bundled and seed themes (ADR 0015) (for
    marketplace and upload installs)
- **Preview across origins**: staff-api issues a signed preview token (theme ID, admin member
  ID, 10-minute expiry). The admin opens `/_preview?token=…` on the user origin; user-app
  accepts it only if the current user session belongs to the same member and that member
  has `acp.themes`, then sets a session grant `preview_theme_id`. Preview responses are
  `private, no-store` and never shared-cached.
- **Guest theme validation**: the `bp` cookie's theme must be active and allowed for Guests;
  otherwise user-app renders the default and re-sets the cookie (ADR 0006).
- **Preview**: the `preview_theme_id` grant changes the variant key (`themeId@version`),
  so the cache stays correct.
- **Chooser**: the allowed list is computed from group snapshots. The member choice is stored
  in `member_prefs`; guests use `bp`.

## Risks / Trade-offs

- [Static checks miss a layout bug a browser would catch] → CI runs WebView smoke renders for
  shipped themes, and installed themes can be previewed before activation.

## Feature flags (ADR 0010)

`theme_chooser` (members picking a theme). Admin theme management is staff-only tooling, exempt under ADR 0010.

Gating: server routes use `requireFlag(key)` (404 when off), templates use `{% if flags.<key> %}`, and islands use `useFlag(key)`. Flags marked `affectsRender` are part of the cache variant (ADR 0006, 0010).

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| Theme and scheme choice (`member_prefs`) | Personal content | personalisation | life of account | the member | included | deleted |
| Template authorship (`theme_templates.updated_by`) | Personal content (staff identity) | accountability | life of the template | staff with `acp.themes` | included for that staff member | set to null |
