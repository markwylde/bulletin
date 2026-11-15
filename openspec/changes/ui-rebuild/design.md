# ui-rebuild — design

Binding design language: **ADR 0021**. This file covers how the work is done.

## Approach
1. **Delete first, then rebuild.** Each track removes the old styles and markup and writes new
   ones. Old components are not patched up. Logic (`page.ts` view models, clients, the overlay,
   islands' behaviour) is kept and may be extended (for example breadcrumbs or avatars in a view
   model) with contract version bumps per ADR 0008.
2. **Hooks are the contract.** Before rewriting a template, list its `data-*` attributes and
   check that each one is still present afterwards (`scripts/ui-hooks.ts` diffs them against main).
   If a hook becomes meaningless, update the client and the tests together.
3. **Screenshot loop.** `scripts/ui-shots.ts` captures a fixed page list (guest and member, user
   and staff) at 360/768/1440 in light and dark into `.shots/<name>/`. Each phase is reviewed
   from these before it merges.

## User app
- Tokens: rewrite `tokens.json`: neutral scale, blue accent, semantic colours (success,
  warning, danger, info), radius, spacing, type scale, font stacks, `width: 80rem`.
- Font: Inter variable woff2 served by user-app from `/fonts/` (immutable cache), preloaded in
  `head.liquid`.
- Shell templates: `header`, `breadcrumbs`, `footer`, a page-header pattern, and empty/error
  states.
- Page templates, in priority order: home, forum, topic + post, search, profile, members/online,
  leaderboards, conversations, account/*, moderation/*, auth/display-name/privacy/unsubscribe,
  error/offline/api-docs/demo/plugin.
- Islands restyled: Editor (toolbar, tabs, attachment tray), Reactions, PostReputation,
  ThemeChooser and LanguageSwitcher (moved to the footer and the account menu), LocaleSuggestion
  (a slim banner), FeedLinks, PluginApp, ApiDocs.
- Pages built directly in Astro/TS (account, moderation, reports, warnings, leaderboards and so
  on) are reworked to the same markup patterns.

## Staff app
- `sections.ts` gains `area` and `group` for every section. The rail, panel, breadcrumbs and
  command search are derived from it.
- Kit in `apps/staff-app/src/ui/`: PageHeader, Breadcrumbs, Button, IconButton, Field,
  SettingsRow, TextInput/Select/Checkbox/Switch, Table (responsive), Badge, Tabs, Panel,
  EmptyState, Skeleton, Dialog, Toast, Menu. `packages/ui` DataTable/ConfirmDialog/Toast/
  FormRenderer are restyled to match or replaced by the kit.
- Every page is rebuilt on the kit, group by group.

## Second theme
"Lounge": the default templates with a card-grid `home.liquid` and its own tokens. It is kept
small on purpose.

## Testing (ADR 0015)
- `bun run check` and the full `bun run test:e2e` gate every phase.
- Adds a tablet viewport (768) to `VIEWPORTS`, a breadcrumb E2E across routes, a staff nav E2E
  (area → group → section, plus a denied section hidden), and no-horizontal-overflow assertions at
  360 for every page in the shot list.
- `theme-visual` contrast checks are kept and cover the new tokens.
