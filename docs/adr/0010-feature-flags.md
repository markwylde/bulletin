# 0010 — Feature flags

**Status:** Accepted (revised after review)

## Decision
- Flags live in `core.feature_flags` and are managed in the staff app. Each has a key,
  description, owner, default, `affectsRender`, and rules evaluated in order:
  - target groups (any of the viewer's groups),
  - percentage rollout (stable hash of `flagKey + memberId`). **Not applied to guests for
    `affectsRender` flags** (ADR 0006); guests get the Guests-group result,
  - environment default from code (`packages/flags/defaults.ts`).
- Evaluation is in-process and synchronous from cached definitions, invalidated by the `flags` tag.
- `renderFlagsHash` in the cache key is computed from the **evaluated values** of
  `affectsRender` flags for the current viewer.
- Plugins can declare flags in their namespace.
- Every new user-facing feature ships behind a flag; the flag is removed once stable.
- Flags are available in templates (`{% if flags.newEditor %}`) and React (`useFlag`).
- Server-side enforcement: a disabled feature's endpoints also reject requests, not just the UI.

## Consequences
- Flag cleanup is part of feature "done".
