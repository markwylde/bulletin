# Design

## Context

Uses the permission model from `groups-permissions` and the template, island and cache stack
from `rendering-and-caching` (ADR 0006, 0008). The index and forum routes are the first real
routes: each ships default-theme templates, a view-model contract (`deps`, `tags`, CDN
eligibility) and a registration in the cache variant harness, replacing the demo route as the
benchmark target.

## Goals / Non-Goals

**Goals:** a tree model that supports fast ancestor and descendant queries, plus correct counts.

**Non-Goals:** topics (change `topics-posts`); the cache machinery itself (`rendering-and-caching`).

## Decisions

- **Tree storage**: adjacency list (`parent_id`, `position`) plus a materialised `path ltree`
  for ancestor and descendant queries. Moves update `path` for the subtree in one transaction.
  *Alternative:* nested sets. Rejected because moves are expensive.
- **Counters**: `topic_count`, `post_count`, and last-post columns on forums, maintained
  transactionally by posting (change `topics-posts`). Board index "latest readable post" uses per-forum
  last-post rows for approved content, plus a per-viewer fallback query only when the viewer
  has see-unapproved bits (the dependency is declared).
- **Rules and announcements markdown**: stored raw here; rendered through the content pipeline
  once change `content-pipeline` lands. Until then, rendered as escaped plain text.
- **Cache tags**: index fragments are tagged `board`, forum pages `forum:{id}` plus ancestors,
  and announcement blocks `announcements` (global) or `forum:{id}:announcements`. Tree moves,
  setting changes and announcement edits declare these tags through `runMutation`.
- **Password forums**: the unlock is a variant dimension (ADR 0006), so an unlocked page is never
  served to a viewer who hasn't unlocked.
- **Announcement audiences**: announcement blocks declare the viewer's announcement audience
  class as a dep (ADR 0005), so members of a targeted group and everyone else get different
  variants; guests share the Guests-group class. No inline group checks.
- **Scheduling**: announcement fragments cap their TTL at the next start or end time, and the
  minute transition worker bumps `announcements` / `forum:{id}:announcements` (ADR 0006).
- **Dismissals**: `core.announcement_dismissals(member_id, announcement_id, version)`.
  Dismissal state goes into the personal overlay (ADR 0006), not shared HTML.
- **Slugs**: generated with transliteration, stored, with old slugs kept in
  `core.slug_history` for redirects.

## Risks / Trade-offs

- [ltree updates on large subtree moves] → acceptable at forum scale (hundreds of forums).

## Feature flags (ADR 0010)

`announcements`. The board index and forum pages are core reading, exempt under ADR 0010.

Gating: server routes use `requireFlag(key)` (404 when off), templates use `{% if flags.<key> %}`, and islands use `useFlag(key)`. Flags marked `affectsRender` are part of the cache variant (ADR 0006, 0010).

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| Announcement dismissals (`core.announcement_dismissals`) | Personal content | hide dismissed notices | until the announcement is deleted | the member, via the overlay | included | deleted |
| Rules-box collapse state | Personal content (client only) | UI preference | browser storage | the device only | not held server-side | — |
