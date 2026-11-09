# Proposal

## Why

The IPB-style group and permission matrix is the core of the product (ADR 0005). Forums,
posting, moderation, caching and plugins all depend on `can()` and the visibility key.

## What Changes

- Groups with a primary group and secondary groups, plus a typed group-settings registry with merge rules.
- Permission masks and the per-forum mask × action matrix, with inheritance and the ancestor rule (forums themselves arrive in change `forum-structure`; this change defines the matrix model against a forum tree interface, tested with fixtures).
- Per-forum moderators (member or group) with granular powers, and global moderator powers.
- `can()`, compiled permission snapshots, member and session grants, and the capability accessor with dependency tracking.
- Auto-promotion rules evaluated by workers.
- Staff screens: groups, group settings matrix, masks, the forum permission matrix (enabled when forums exist), moderators, promotion rules.

## Capabilities

### New Capabilities
- `groups`: groups, membership, group settings and auto-promotion.
- `forum-permissions`: masks, the forum action matrix, inheritance, password grants and permission evaluation.
- `moderator-assignments`: per-forum and global moderator powers.

### Modified Capabilities
- None.

## Impact

- `packages/domain/permissions`, staff-app, staff-api, workers. Replaces the interim ACP flags from change `staff-console-shell` with registry entries.
