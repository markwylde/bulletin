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
- **Dismissals**: `core.announcement_dismissals(member_id, announcement_id, version)`.
  Dismissal state goes into the personal overlay (ADR 0006), not shared HTML.
- **Slugs**: generated with transliteration, stored, with old slugs kept in
  `core.slug_history` for redirects.

## Risks / Trade-offs

- [ltree updates on large subtree moves] → acceptable at forum scale (hundreds of forums).

## Feature flags (ADR 0010)

None: core reading, exempt under ADR 0010.
