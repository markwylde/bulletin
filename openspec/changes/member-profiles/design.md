# Design

## Context

Builds on permissions (group settings), events (badge rules, friend notifications), the
content pipeline (signatures, about) and caching (profile variants, overlay).

## Goals / Non-Goals

**Goals:** cached profile and member list pages; a cheap who's-online count.

**Non-Goals:** profile comments and status feeds (out of scope per `features.md`).

## Decisions

- **Custom fields**: `profile_fields(id, type, required, label_keys, options, position)`,
  `profile_field_groups(field_id, group_id, can_view, can_edit)` and
  `member_field_values(member_id, field_id, value jsonb)`.
  - Viewer field-visibility class = hash of the set of field IDs the viewer can see (declared
    dep), so profile variants stay few.
- **Signatures**: rendered via the signature profile and stored rendered. Limits are checked
  on save against group settings. Under posts, signatures are a separate cached fragment per
  member (`member:{id}:sig`). "Hide signatures" and ignore are applied client-side via the
  overlay.
- **Online tracking**: `presence(member_or_guest_key, location_forum_id, last_seen)` UNLOGGED,
  upserted at most once per minute per viewer. It is recorded by the member overlay request
  and the guest beacon (ADR 0006), since cached and CDN pages never reach the server on render. Counts are a cached query with 60 s TTL
  (allowed to be eventual). Locations are filtered by the viewer's `read` bits in the full list.
- **Leaderboards**: a nightly plus hourly job materialises `leaderboard_entries(period,
  metric, member_id, value)` counting only posts in forums readable by Guests (computed via
  the Guests snapshot). Tags are bumped in the same transaction.
- **Badges**: `badges`, `badge_rules` and `member_badges(member_id, badge_id, awarded_by,
  reason, created_at, revoked_at)`. The rule evaluator subscribes to `post.approved`,
  `reaction.added`, `reputation.given` and `topic.created`, with a nightly sweep. It uses
  `INSERT … ON CONFLICT DO NOTHING` for at-most-once awards.
- **Author card fields**: this change adds rank title and pips, custom title and featured
  badges to `member:{id}:card` (from `topics-posts`). Invalidation: a custom title change or
  featured-badge change bumps `member:{id}`; editing rank thresholds or images bumps `ranks`
  (every card rebuilds once; post blocks are untouched); crossing a rank threshold by post
  count is covered by the post-count bump on `member:{id}`.
- **Ignore and friends**: `member_ignores(member_id, ignored_id)` and
  `friendships(a, b, state, requested_by)`. The notification recipient filter (from change `events-notifications`)
  adds the ignore check. The conversation policy (change `conversations`) consults ignores.

## Risks / Trade-offs

- [Location leakage in who's online] → the location is shown only if the viewer can `read` that forum; covered by a test.

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| Profile field values, signature, custom title | Personal content | public profile | life of account | per-field group visibility | included | deleted |
| Friendships, ignores | Personal content | social graph, filtering | life of account | the member only (friends list per privacy setting) | included | deleted |
| Presence (UNLOGGED, guest key or member) | Derived | who's online | 15 minutes | location filtered by the viewer's `read` bits | excluded | deleted |
| Awarded badges, leaderboard entries | Personal content / derived | recognition | life of account | public | badges included | deleted |

## Feature flags (ADR 0010)

`friends`, `leaderboards`, `badges`. Profiles and the member list are core.

Gating: server routes use `requireFlag(key)` (404 when off), templates use `{% if flags.<key> %}`, and islands use `useFlag(key)`. Flags marked `affectsRender` are part of the cache variant (ADR 0006, 0010).
