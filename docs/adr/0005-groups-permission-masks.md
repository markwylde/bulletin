# 0005 — Groups, permission masks and moderators

**Status:** Accepted (revised after review)

## Context
The heart of IPB was its group settings and the forum permission matrix. We replicate that
model and define its semantics precisely, because caching (ADR 0006) depends on them.

## Decision
### Groups
- Each member has one **primary group** (controls display: name colour, rank, group icon) plus
  any number of **secondary groups**.
- **Group settings** are a typed registry (`domain/permissions/registry.ts`). Each entry
  declares key, type (bool/int/enum/duration), default, **merge rule**, i18n label and ACP
  section. Merge rules:
  - `allow-any`: boolean, true if any group grants it (most capabilities).
  - `restrict-any`: boolean, true if any group sets it (e.g. `posts_require_approval`,
    `banned`, `cannot_pm`). A restriction always wins over an allowance.
  - `max` / `min`: numeric (e.g. upload quota uses `max`, flood control seconds uses `min`).
  - `primary`: taken from the primary group only (display settings).
- Examples: edit window, delete own posts, flood control, PM quota and recipients, upload quota
  (total/per-file/types), signature limits, avatar limits, display-name changes per period,
  can react, can give reputation, can vote, theme access, search flood, link limits,
  moderation queue (first N posts).
- Plugins register settings in `plugin.<id>.*`.
- No per-user permission overrides. Use a group.
- **Auto-promotion**: ordered rules (`from group` → `to group` when approved post count ≥ N
  and/or days since join ≥ D and/or reputation ≥ R). Evaluated by a worker on post events and
  nightly, under `SELECT … FOR UPDATE` on the member row, so promotions are idempotent and race-free.

### Forum permission masks (IPB style)
- A **mask** is a named, reusable permission set. Each group links to one or more masks.
- Per forum, the matrix is `mask × action`. Actions:
  - `show`: forum appears in lists, with its name and description. **Topic titles are not shown.**
  - `read`: open the forum, list topics and read posts. Implies `show`.
  - `start`, `reply`, `upload`, `download`, `vote`
  - plugin-registered actions
- **Ancestor rule**: a member's effective action on a forum is ANDed with `show` on every
  ancestor. A hidden parent hides the whole subtree.
- Forums inherit their parent's matrix unless overridden.
- **Password forums**: `read` additionally requires a session unlock. An unlock is a
  **session grant** (ADR 0018) stored in `core.session_grants`, not a permission.

### Moderators
- **Forum moderators** are assigned per forum to a member *or* a group, with granular powers:
  edit, soft-delete, hard-delete, restore, move, merge, split, pin, lock, approve,
  see unapproved, see deleted, view IPs, warn, view edit history, use multi-mod.
- An assignment applies to sub-forums unless marked "this forum only".
- Global moderator powers (super moderators) are group settings.

### Evaluation and the visibility key
Permissions compile in three layers:
1. **Group snapshot**: from the sorted set of group IDs. Shared by everyone with that group set.
2. **Member grants**: member-specific moderator assignments.
3. **Session grants**: unlocked password forums.

The effective result is a **per-forum capability bitmap**
`forum → {show, read, start, reply, upload, download, vote, mod powers…}`.
- `domain/permissions.can(ctx, action, resource)` is the only way to check. There are no inline checks.
- **Resource visibility key**: for any cacheable view model, the cache key is a hash of the
  **capability bits that view model actually reads**. Each view-model builder declares those
  bits (`deps`).
  - topic page: its forum's `read, reply, upload, vote, see_unapproved, see_deleted`, plus
    every mod power that renders a control, plus the `read` bit of any forum whose content
    is embedded (quotes, ADR 0007)
  - forum index: `show`/`read`/`see_unapproved`/`see_deleted` for all forums (they affect
    counts and last-post previews)
  - profile: the viewer's visibility class for custom profile fields (the set of field
    groups the viewer may see)
- **Enforcement, not convention**: builders receive a capability accessor, not the raw
  bitmap. In dev and test, the accessor records every bit read during a render and throws if a
  bit was read that the builder did not declare. CI renders every route under the seeded
  profiles with tracking on. This is what makes the key complete; a missing dependency fails the build.
- Members with different groups but identical relevant bits share cache entries.
- Every reader of forum content, including search, attachments, RSS, sitemap, previews,
  counters, notifications, webhooks, SSE and the public API, uses `can()`. CI has an
  architectural test that fails if a content query bypasses the permission-filtered
  repository functions.

## Consequences
- The ACP matrix (forums × masks, with bulk toggles) is a major staff-app feature.
- The semantics above are the contract; changing them needs a new ADR.
