# Proposal

## Why

ADR 0010 requires every new user-facing feature to ship behind a flag, with group targeting
and percentage rollout. Flags must exist before the feature changes that depend on them.

## What Changes

- Flag definitions with group targeting, percentage rollout and code defaults.
- In-process evaluation; render-affecting flags feed the cache variant.
- Server-side enforcement helpers for flagged endpoints.
- Flag management section in the staff app, with change history.
- Template and React accessors.

## Capabilities

### New Capabilities
- `feature-flags`: defining, targeting, evaluating and enforcing feature flags.

### Modified Capabilities
- None.

## Impact

- `packages/flags`, staff-app, staff-api, user-api, user-app. Adds `core.feature_flags`.
