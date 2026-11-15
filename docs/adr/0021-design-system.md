# 0021 — Design system and UI shells

**Status:** Accepted

## Context
Part 1 shipped working features, but the interface did not hold up: a narrow boxed column, a
card around every section, no breadcrumbs, form controls in the page header, and a flat staff
sidebar with 39 entries. Both front ends are being rebuilt from scratch (change `ui-rebuild`).
Behaviour, routes, view models, caching and the `data-*` hooks used by client code and tests stay
the same. This ADR fixes the visual language and the page shells so later work stays consistent.
It adds to ADR 0008 (themes) and ADR 0014 (mobile-first) and supersedes neither.

## Decision
### Visual language
- Clean, modern, professional SaaS. Neutral greys with **one blue accent**. Borders and
  background tints separate areas. **No decorative shadows.** The only shadow is a hairline
  elevation on popovers and dialogs. No gradients, no transforms or scale effects on hover. Hover
  changes colour or background only.
- **Inter**, self-hosted as a variable woff2 from our own origin (CSP-safe), with a system-font
  fallback. Tabular numerals for counts.
- Radius **6 px** on controls and panels, 4 px on small badges.
- 4 px spacing scale. Body text 14 px on dense lists, 15–16 px for post content.
- Light, dark and system schemes, all built from the same tokens. Contrast is AA or better and
  is checked by tests (ADR 0008 theme checks).

### Layout
- Full width with a **1280 px content cap**. No outer frame or border around the page. Gutters
  are 16 px on phones, 24 px on tablets and 32 px on desktops.
- Breakpoints: 360 (base), 640, 768 (tablet), 1024, 1280. Every screen is designed and checked
  at 360, 768 and 1440.
- **Breadcrumbs on every page** except the board index, driven by the view model. On phones the
  trail collapses to "‹ parent".

### User app (themeable, ADR 0008)
- Shell: a top bar with the brand, primary nav, search, and the member's area (notifications,
  messages, avatar menu). Then a page header (breadcrumbs, title, meta, primary actions), then the
  content, then a footer (language, colour scheme, theme, legal links, board stats link).
- Language, scheme and theme choices live in the **footer and the account menu**, never in the
  top bar.
- **Forums are lists, not cards.** The board index groups forums into category sections. Each is
  a bordered panel with a header row and divided forum rows: an unread marker, title,
  description, subforums, counts and the last post. Topic lists use the same row pattern. Below
  768 px, rows **stay rows**: the count columns fold into a meta line under the title and the
  last post moves to a second line. This is a deliberate exception to ADR 0014's "tables become
  cards"; it does not apply to forum and topic lists. A card layout is offered only as an
  optional seeded theme.
- Posts: author column on the left at ≥ 768 px; author header inline above the post on phones.

### Staff app (not themeable)
- Shell: an **icon rail** of top-level areas plus a **grouped sub-navigation panel** for the
  selected area. A top bar holds a section-search command field, "View site" and the account
  menu (scheme, language, log out). On phones the rail and panel become one drawer.
- Areas: Overview · Members · Forums & content · Moderation · Appearance · Integrations ·
  Privacy · System. Every section belongs to exactly one area and group in `sections.ts`. Nav,
  breadcrumbs and route guards are all derived from that list.
- Pages share a page header (breadcrumbs, title, description, actions), settings forms laid out
  as label/description on the left and the control on the right (stacked on phones), and data
  tables that become stacked rows on phones.

### Code rules
- One token source per app: theme tokens in `packages/templates/themes/default/tokens.json`, and
  the staff tokens in `apps/staff-app/src/styles/tokens.css`.
- Class names are for styling only. Behaviour and tests use `data-*` hooks, and existing hooks
  are kept.
- Icons are inline SVG from a single icon module per app. No icon fonts.

## Consequences
- Every visual change is reviewed from screenshots at 360/768/1440 in light and dark.
- Themes built for the old markup need their templates re-based on the new default.
