# 0008 — Themes and templates (user app only)

**Status:** Accepted (revised after review; spike S1 complete)

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

#### Spike S1 findings (rendering-and-caching)
Outcome: the rendering model above is **accepted**; no superseding ADR is needed. The
prototype is the real user app (dev-only `/spike/rendering`), the renderer is
`packages/templates`, the fragment store is `packages/cache` and the two prototype themes are
seeded into `core.render_spike_*`. Tasks 2.1-2.3 and 8.2 replace the prototype storage and
hardening; task 4.2 owns the production `/_demo/<id>` route and its 404 guard.

**Adapter choice: `@astrojs/node` 11.1.11 (standalone), run by Bun.** Candidates were built and
run under Bun 1.4.0 with Astro 7.4.7 on Linux arm64 (compose dev image, Podman 6.1.4):

| Candidate | Result |
|---|---|
| `@nurodev/astro-bun` 2.1.2 | Peer range is Astro `^5.1.1`. It installs with a peer warning and builds against Astro 7, but emits the removed legacy SSR entry and dies at startup (`new App(...).getAdapterLogger is not a function`). Rejected. |
| `@igloczek/astro-bun-adapter` 1.2.0 | Works on Astro 7.4.7 and serves correctly on Bun 1.4.0, but declares `engines.bun >= 1.4.4`. Pinning it means bumping Bun in `packageManager`, every Dockerfile and CI (ADR 0001) for a single-maintainer adapter, and its speed matched the Node adapter. Rejected for this spike; revisit if Astro ships an official Bun adapter or the project moves past Bun 1.4.4. |
| `@astrojs/node` 11.1.11 | Builds and serves every case the app needs under Bun. Official, inside Astro's support policy, no runtime bump. **Chosen.** |

Both viable adapters passed the same correctness checks on the built route: streaming flushes
the first chunk before the body finishes, `Cache-Control`, `Surrogate-Key` and custom headers
pass through, multiple `Set-Cookie` headers survive, `301` keeps `Location`, POST bodies and
static assets from `dist/client` work. `astro preview` is a background daemon in Astro 7
(`astro preview stop`), so the production image runs `bun ./dist/server/entry.mjs` instead.

**Measured cost** (`bun scripts/spike-rendering.ts`, the same built `/spike/rendering` route,
sequential requests, 30 cold and 200 warm samples, cached variant warmed first):

| Measurement | Node adapter | Bun adapter |
|---|---|---|
| in-process Liquid parse + render + island SSR, p50 / p95 | 0.17 / 0.73 ms | 0.16 / 0.83 ms |
| cached fragment lookup, p95 | 0.01 ms | 0.01 ms |
| HTTP cold (miss, includes both DB reads), p50 / p95 | 1.43 / 3.92 ms | 1.44 / 3.60 ms |
| HTTP warm (hit), p50 / p95 | 0.72 / 0.88 ms | 0.74 / 1.01 ms |

Against the dev stack through Caddy with a remote database the same script measured cold
p50 3.13 / p95 6.30 ms and warm p50 2.48 / p95 3.98 ms. The ADR 0006 targets (cold p95 < 200 ms,
cached guest p95 < 30 ms) hold on this data; task 7.1 adds the seeded, CI-wired benchmark.

**What the prototype proved.**
- A template body stored in Postgres renders through LiquidJS with `{% t %}` and autoescaping;
  a view-model string containing `<script>` reaches the page as text.
- `{% island "SpikeCounter" props %}` validates props against the registry, server-renders the
  React component with `renderToString` and emits `<bl-island data-name data-props>`; a small
  client script hydrates the same component with `hydrateRoot`. No Astro directives or React
  integration are involved, which confirms the "our own island runtime" decision.
- `{% hook "spike.after.counter" %}` renders a plugin-style fragment for the current plugin
  generation, in the page's scope, with the same escaping rules.
- A theme switch and a plugin-generation bump each produce a distinct cache entry, a repeated
  request hits (including after other variants were rendered), and neither variant's HTML
  leaks into the other.

**Notes for the follow-up tasks.**
- `outputEscape: "escape"` escapes `{{ }}` only, so tags that write raw markup (`{% island %}`,
  `{% hook %}`, `{% t %}`) escape their own writes; that is now a unit-tested invariant.
- The spike's store is single-theme and its cache separates variants only. Parent fallback and
  the compile cache (2.1), save-time validation (2.2), resource-limit fallback (2.3) and tag
  versions, invalidation and fail-closed bypass (5.x) are deliberately not in it.
- Moving the user app to `output: "server"` made `Astro.locals` and the enforcing middleware
  path real for every page, which the prerender caveat in `middleware.ts` recorded as needed.

## Consequences
- No data fetching in templates, only the view model.
- View-model changes are breaking for themes and need versioning and a changelog.
