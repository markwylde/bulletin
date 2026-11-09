# 0017 — Search on Postgres full-text

**Status:** Accepted (revised after review)

## Decision
- **Indexing is synchronous, with no lag**: topics and posts have a `lang regconfig` column
  (set from the forum language or detected at write time; `english`, `spanish`, `french` or
  `simple`). They also have a **generated** column
  `tsv tsvector GENERATED ALWAYS AS (to_tsvector(lang, title/body_text)) STORED` with a GIN
  index. `body_text` is plain text produced by the content pipeline (ADR 0007). It **excludes
  quote snapshots**, so quoted text from other posts is never searchable or highlighted through
  the quoting post.
- **Querying**: `websearch_to_tsquery` is run against both the viewer's locale config and
  `simple`, ORed together, so mixed-language content still matches. Results are ranked with
  `ts_rank_cd` plus recency. `pg_trgm` is used for member names and title fuzzy matching.
- **Authorisation at query time**: result queries join current topic/post state and filter
  by the viewer's `read` bitmap (ADR 0005) and current deletion/approval state. Unapproved
  and deleted content appears only for viewers with those moderator bits. There is no stale
  visibility, because nothing is precomputed.
- **Highlighting**: `ts_headline` over `body_text` (plain text). The output is HTML-escaped,
  then our highlight markers are applied. It is never rendered as raw HTML.
- Filters: forum(s), author, date range, prefix/tag, topics vs posts. Search flood control
  comes from group settings.
- **Rebuild**: changing a forum's language bumps the `lang` of its rows in batches via a worker.
- The search module sits behind an interface so another engine could replace it later through
  a new ADR.
