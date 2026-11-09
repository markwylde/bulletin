# 0008 — Themes and templates (user app only)

**Status:** Accepted, pending spike S1 (revised after review)

## Context
Admins must be able to fully customise the look of the **user app**, like IPB skins, and
install themes from the marketplace at runtime. The **staff app is not themeable**: it is
hard-coded, with light and dark mode only.

## Decision
### Theme contents
A theme is a versioned set of:
- **Templates** (LiquidJS). They are stored in the DB (`core.theme_templates`), edited in the
  staff app with a diff view and revert, and inherit from a parent theme.
- **CSS** using design tokens (custom properties) with light and dark variants.
- **Assets** in storage (ADR 0019).
- **String overrides** (optional).

### Rendering architecture
- **Astro's role**: routing, middleware, SSR shell, asset pipeline, and building the island
  client bundle. Page bodies are produced by the template engine from a **typed view model**
  per route. View models are a versioned contract (`packages/templates/contracts`).
- **Our own island runtime, not Astro directives.** Astro hydration requires statically
  imported components, so runtime-placed islands use a bridge:
  - A **fixed island registry** (`packages/ui/islands`): name → React component + props schema.
  - `{% island "Editor" props %}` validates the props against the schema, SSRs the component
    with `renderToString`, and emits `<bl-island data-name data-props>` with props JSON-encoded
    and HTML-escaped.
  - A small client runtime finds islands and `hydrateRoot`s them from code-split chunks.
    Chunks are built by Astro/Vite and listed in a manifest.
  - Themes can position or wrap islands. Each route declares **required islands** (e.g. the
    reply editor on topic pages when the viewer can reply). Themes may omit only optional islands.
- **Astro adapter**: chosen and pinned in spike S1. Preference is a maintained Bun adapter;
  the fallback is `@astrojs/node` (standalone) running under Bun.

### Template security (themes are third-party code)
- **Autoescape on** for all output. Raw HTML comes only from trusted view-model fields typed
  `SafeHtml` (already sanitised content, ADR 0007). No filter can mark a string as safe.
- **Template output sanitising**: each compiled fragment's static markup is checked at
  **save/install time** by a theme profile of the sanitiser. It rejects `<script>`, `on*`
  attributes, `javascript:`/`data:` URLs, `<iframe>`, `<object>`, `<embed>`, `<base>`,
  `<meta http-equiv>`, and forms posting off-origin. Rendered fragments are re-sanitised once at
  fragment build (results are cached, so it is off the hot path). A template that fails is
  rejected with a clear error.
- **CSS**: parsed and filtered. No `@import` or `url()` outside the theme's assets, and no
  legacy expression syntax.
- **Resource limits**: LiquidJS `parseLimit`, `renderLimit` (time), `memoryLimit`, max
  include depth, and max output size. Exceeding a limit falls back to the parent theme's
  template and logs the error.
- A strict **CSP** on the user app: scripts only from our origin with nonces. Plugin client
  code is iframed (ADR 0009).
- Themes cannot run JavaScript. Custom behaviour comes only through plugins.

### Hooks, caching and availability
- Templates contain named hooks (`{% hook "post.userbar.after" %}`) for plugin fragments.
  The canonical hook list lives in the registry, and CI checks the default theme contains every hook.
- Compiled templates are keyed by `themeId@version + pluginsGeneration`.
- **Availability by group**: each theme has allowed groups, and admins set a default theme per
  group. Members choose among the themes they may use, plus light/dark/system.
- A **default theme** ships in the repo, and the seed installs a second theme.
- Theme checks run at install: required islands present, responsive at 360 px, contrast for
  both schemes.

### Spike S1 (before feature work)
Runs as change `rendering-and-caching`, before any feature page, on a dev-only demo route.
Prove the end-to-end flow: a DB-stored template places an island → SSR → hydration → theme
switch → plugin hook fragment → cache hit. Also measure render cost. Record the adapter choice here.

## Consequences
- No data fetching in templates, only the view model.
- View-model changes are breaking for themes and need versioning and a changelog.
