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
  case), and a separate path for moderators. Ranking considers at most the 10,000 most recent
  matches (common words can match the whole board); results are paginated with a hard cap of
  1,000 hits.
- **Rebuild**: changing a forum's language updates `lang` in batches of 1,000 via a worker job.

## Risks / Trade-offs

- [Large readable-forum arrays for admins] → fine at forum scale (hundreds).
- [Mixed-language posts] → the `simple` OR-branch catches exact words.

## Feature flags (ADR 0010)

`search`.

Gating: server routes use `requireFlag(key)` (404 when off), templates use `{% if flags.<key> %}`, and islands use `useFlag(key)`. Flags marked `affectsRender` are part of the cache variant (ADR 0006, 0010).

## Privacy (ADR 0012 checklist)

- **Classification.** Topic titles and post bodies are public community content. Author member IDs
  and display names are public identity fields already governed by the member profile. Member
  search returns only display names and group labels; hidden members are excluded unless the
  viewer has `members.view_hidden`. `previous_visit_at` and `joined_at` are personal visit data
  used to build the new-content view.
- **Purpose.** Search indexes content so members can find readable discussions. The only search
  telemetry is the UNLOGGED rate bucket: a member ID or pseudonymous guest key, a timestamp and a
  count, used solely to enforce the group's search interval. The query text is never stored.
- **Retention.** Search adds no durable history. Rate buckets live in `core.rate_buckets` and are
  purged by the existing retention sweep; visit timestamps already follow the member retention
  policy. Generated `tsv` columns contain the same public content as their source columns and
  disappear with the row.
- **Access.** Every query is filtered by the viewer's live `can()` snapshot (`read`,
  `see_unapproved`, `see_deleted`) and never trusts a precomputed index for visibility. Member
  results honour the member-list opt-out. Route responses are `private, no-store`.
- **Export.** Search introduces no new exportable personal store. Existing member export covers
  the visitor timestamps and profile fields; posts are exported with the member's content.
- **Erasure.** Deleting or anonymising a member removes their name from search results through
  `core.members`, and posts survive with `author_id` null as ADR 0012 requires. Rate buckets and
  visit timestamps are removable by the member erasure job; there is no search-query log to erase.
