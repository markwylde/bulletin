# Design

## Context

Uses the permission model from change 6. Pages render with a minimal Astro layout until
change 8 introduces the template engine and caching. Routes must still go through `can()`.

## Goals / Non-Goals

**Goals:** a tree model that supports fast ancestor and descendant queries, plus correct counts.

**Non-Goals:** topics (change 10); caching (change 8).

## Decisions

- **Tree storage**: adjacency list (`parent_id`, `position`) plus a materialised `path ltree`
  for ancestor and descendant queries. Moves update `path` for the subtree in one transaction.
  *Alternative:* nested sets. Rejected because moves are expensive.
- **Counters**: `topic_count`, `post_count`, and last-post columns on forums, maintained
  transactionally by posting (change 10). Board index "latest readable post" uses per-forum
  last-post rows for approved content, plus a per-viewer fallback query only when the viewer
  has see-unapproved bits (the dependency is declared).
- **Rules and announcements markdown**: stored raw here; rendered through the content pipeline
  once change 9 lands. Until then, rendered as escaped plain text.
- **Dismissals**: `core.announcement_dismissals(member_id, announcement_id, version)`.
  Dismissal state goes into the personal overlay (ADR 0006), not shared HTML.
- **Slugs**: generated with transliteration, stored, with old slugs kept in
  `core.slug_history` for redirects.

## Risks / Trade-offs

- [ltree updates on large subtree moves] → acceptable at forum scale (hundreds of forums).
