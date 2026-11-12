# Proposal

## Why

Members need to find topics, posts and members. ADR 0017 chose Postgres full-text search
with query-time authorisation.

## What Changes

- Generated `tsvector` columns with per-row language config and GIN indexes on topics and posts.
- Search page and quick search: query syntax, filters (forums, author, date range, prefix, topics vs posts), sorting (relevance, date).
- Safe highlighted snippets.
- Member name search with trigram matching.
- Search flood control from group settings.
- Language rebuild job when a forum's language changes.
- "Find content by this member" and "new content since last visit" views.

## Capabilities

### New Capabilities
- `search`: finding topics, posts and members, with results limited to what the viewer can read.

### Modified Capabilities
- None.

## Impact

- Migrations (generated columns, indexes, `pg_trgm`), user-api search endpoints, user-app search UI, workers (rebuild job).
