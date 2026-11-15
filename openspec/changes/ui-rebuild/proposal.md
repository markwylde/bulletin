# ui-rebuild

## Why
Part 1 delivered working features with an interface that does not hold up: a narrow boxed
column, a card around every section, no breadcrumbs, settings controls in the header, and a flat
39-item staff sidebar. Both front ends are rebuilt from scratch to the design system in ADR 0021.

## What changes
- All user-app styling and default-theme markup (`packages/templates/themes/default/*`,
  `apps/user-app/src/theme/default.css`, the island components in `packages/ui`) is rewritten.
- All staff-app styling, shell and page markup is rewritten on a small component kit.
- Breadcrumbs become part of every user-app view model. The staff app gets area/group
  navigation.
- A second seeded theme ("Lounge") offers a card-style board index as an option.
- Unchanged: routes, view-model data, caching and variant keys, APIs, permissions, flags,
  i18n keys (new keys are added, none are removed while they are in use), and every `data-*` hook
  that client code or tests depend on.

## Impact
ADRs 0006, 0008, 0013, 0014, 0015 and 0021. There is no schema change apart from the theme
seed. No personal data is added (the ADR 0012 checklist does not apply). Flags: none are new; the
existing flags still gate the same UI.
