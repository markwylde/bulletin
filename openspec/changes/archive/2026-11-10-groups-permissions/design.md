# Design

## Context

ADR 0005 is the contract. ADR 0006 consumes the visibility key. Forums don't exist until
change `forum-structure`, so the matrix is built against a `ForumTree` interface and tested with fixture trees.

## Goals / Non-Goals

**Goals:** O(1) per-request permission lookups; correctness proven by property tests.

**Non-Goals:** per-user overrides (rejected in ADR 0005); ban workflow (change `moderation`).

## Decisions

- **Snapshot compilation**:
  - Group snapshots are keyed by the sorted group-ID set. Each holds the merged settings plus
    a per-forum bitmap (a `Uint32Array` per forum: bits for actions and mod powers).
  - The member layer ORs in member-specific moderator assignments.
  - The session layer adds password unlocks as a separate `unlocked` set. `CapabilityView`
    folds it into the effective `read` bit, and records when a read bit depended on an unlock
    so the response is marked not CDN-cacheable (ADR 0005).
  - Snapshots are cached in-process, invalidated by tag `perm` with the 1 s backstop.
- **Ancestor rule at compile time**: the bitmap stored for each forum already has the
  ancestor `show` AND applied, so runtime checks are a single bit test.
- **Capability accessor**: `CapabilityView` wraps the bitmap for one render. Each `has(forum,
  bit)` records `(forum, bit)` in dev/test mode and throws if it is not in the view's declared
  deps. `visibilityKey(deps)` hashes only the declared bits.
- **Registry**: `domain/permissions/registry.ts` holds group settings and ACP permissions
  (`acp.*`). Plugins append namespaced entries at load time (change `plugin-platform`).
- **Promotion criteria registry**: `registerPromotionCriterion({key, label, read(memberId)})`.
  This change registers `days_since_joining`; `topics-posts` registers `approved_posts` and
  `reactions-reputation` registers `reputation`. Notifications for promotions come from
  `events-notifications` subscribing to `member.promoted`.
- **Promotion**: worker job `promotion.evaluate(memberId)` runs in a transaction with `SELECT …
  FOR UPDATE` on the member, evaluates rules in order, applies the first match, and emits
  `member.promoted`.
- **Audience classes**: `can()` exposes `announcementAudience(viewer)`, a hash of active
  announcement IDs targeted at the viewer's groups (consumed by `forum-structure`).
- **SQL mirror for definer functions**: `core.has_mod_power(member_id, forum_id, power)` is a
  stable SQL function over `core.member_groups`, group settings (super-moderator) and
  `core.moderators` (with inheritance and `this_forum_only`), so `pii` definer functions can
  check moderator powers inside Postgres (ADR 0012). A property test asserts it agrees with
  the TypeScript `can()` for every power, forum and seeded member.
- **Property tests**: random forum trees × random masks × random group sets, checked against
  a naive reference implementation of ADR 0005 semantics.

## Risks / Trade-offs

- [Snapshot explosion with many group combinations] → snapshots are LRU-bounded; ADR 0020 monitors cardinality.
- [Bitmap width when plugins add actions] → actions map to bit indexes dynamically; the array widens as needed.

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| Group memberships (primary and secondary) | Personal content | access control | life of account | the member, staff with `acp.members` | included | deleted with the member row |
| Moderator assignments | Personal content | per-forum moderation | until removed | public where the forum shows moderators; staff | included | deleted |
| Promotion history (`member.promoted` events) | Derived (IDs only) | audit of auto-promotion | 30 days (event retention) | staff | excluded | ages out |

## Feature flags (ADR 0010)

None: permissions are core, and their screens are staff-only tooling (ADR 0010).
