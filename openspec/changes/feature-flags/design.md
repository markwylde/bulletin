# Design

## Context

ADR 0010; the cache variant includes `renderFlagsHash` from ADR 0006. The caching package
arrives in change `rendering-and-caching`, so this change exposes the evaluated render flags; change `rendering-and-caching` consumes them.

## Goals / Non-Goals

**Goals:** fast synchronous evaluation; safe guest semantics; one API everywhere.

**Non-Goals:** experiments or analytics; per-member manual overrides (use a group).

## Decisions

- **Hashing**: bucket = `xxhash32(flagKey + ":" + memberId) % 10000`. On when
  `bucket < percent*100`. Increasing the percentage only adds buckets, which gives the
  monotonic scenario.
- **Code registry**: `packages/flags/defaults.ts` exports `defineFlag({key, default,
  affectsRender, owner, description})`. On startup, missing keys are upserted with no rules.
- **Storage**: `core.feature_flags(key pk, description, owner, default, affects_render, rules
  jsonb, updated_at, created_at)`. Definitions are cached in-process under tag `flags`, with
  the 1 s backstop from ADR 0006.
- **Accessors**: `flags.isOn(ctx, key)` on the server, `{% if flags.key %}` in templates,
  `useFlag(key)` in React. The client receives only flags marked `clientVisible`, via the
  overlay or page data.
- **Endpoint gate**: `requireFlag(key)` route middleware, which returns 404.

## Risks / Trade-offs

- [Flag sprawl] → the staleness highlight, plus "flag removed" being part of a feature's definition of done.
