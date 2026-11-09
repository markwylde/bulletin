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
- **Ignore and friends**: `member_ignores(member_id, ignored_id)` and
  `friendships(a, b, state, requested_by)`. The notification recipient filter (from change 12)
  adds the ignore check. The conversation policy (change 15) consults ignores.

## Risks / Trade-offs

- [Location leakage in who's online] → the location is shown only if the viewer can `read` that forum; covered by a test.
