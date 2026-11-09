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
- Every new user-facing feature ships behind a flag; the flag is removed once stable. The
  only exemptions, each named in the change's design:
  - core reading and posting (forum index, forum and topic pages, posting, editing, read tracking),
  - safety features members rely on to report abuse and staff rely on to act on it (reports,
    moderation queue, content filters, IP tools), so they can never be switched off by accident,
  - legal obligations (data export and erasure),
  - staff-only tooling in the staff app, which is not user-facing (governed by ACP permissions).
- Flags are available in templates (`{% if flags.newEditor %}`) and React (`useFlag`).
- Server-side enforcement: a disabled feature's endpoints also reject requests, not just the UI.

## Consequences
- Flag cleanup is part of feature "done".
