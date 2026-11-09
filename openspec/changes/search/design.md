# Design

## Context

ADR 0017. `body_text` already excludes quotes (change `content-pipeline`).

## Goals / Non-Goals

**Goals:** correct and fast enough at 1M posts (ADR 0020 target).

**Non-Goals:** external engines; attachment content search.

## Decisions

- **Columns**: `posts.lang regconfig` (from forum language at write time) and
  `posts.tsv tsvector GENERATED ALWAYS AS (setweight(to_tsvector(lang, coalesce(body_text,'')),'B')) STORED`.
  Topics have the title with weight `A`. Each table also gets a `simple` config column for
  the unstemmed match.
- **Query**: `websearch_to_tsquery(viewerLang, q) || websearch_to_tsquery('simple', q)`
  against `tsv || tsv_simple`. Ranked with `ts_rank_cd` and a recency decay.
- **Authorisation**: `WHERE forum_id = ANY($readableForumIds)`, plus visibility conditions
  from the viewer's mod bits per forum (two arrays: see-unapproved forums and see-deleted
  forums). The readable arrays come from the permission snapshot.
- **Snippets**: `ts_headline('simple', body_text, query, 'StartSel=\u0001,StopSel=\u0002,
  MaxFragments=2')`. The result is HTML-escaped, then the sentinels are replaced with `<mark>`.
- **Performance**: a partial GIN index on `posts.tsv WHERE visibility='visible'` (the common
  case), and a separate path for moderators. Results are paginated with a hard cap of 1,000 hits.
- **Rebuild**: changing a forum's language updates `lang` in batches of 1,000 via a worker job.

## Risks / Trade-offs

- [Large readable-forum arrays for admins] → fine at forum scale (hundreds).
- [Mixed-language posts] → the `simple` OR-branch catches exact words.

## Feature flags (ADR 0010)

`search`.

Gating: server routes use `requireFlag(key)` (404 when off), templates use `{% if flags.<key> %}`, and islands use `useFlag(key)`. Flags marked `affectsRender` are part of the cache variant (ADR 0006, 0010).
