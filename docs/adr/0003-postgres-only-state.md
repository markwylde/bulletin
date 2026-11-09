# 0003 — Postgres is the only stateful dependency

**Status:** Accepted (revised after review)

## Context
Every extra stateful system (Redis, Elasticsearch, RabbitMQ…) adds ops cost and breaks the
two-step local setup.

## Decision
Postgres does all of it:
- **Data**: core schema `core`, restricted schema `pii` (ADR 0012), one schema per plugin (ADR 0009).
- **Queues/cron**: pg-boss (schema `pgboss`).
- **Wake-ups**: `LISTEN/NOTIFY` is used **only to wake processes**, never as the system of
  record. Every notified fact is also durable in a table, so missed notifications are
  recovered by re-reading state (ADR 0006, 0011).
- **Search**: built-in full-text search (ADR 0017).
- **Rate limits / flood control**: counters in an `UNLOGGED` table with time buckets.
- **Sessions**: `core.sessions` table.
- **Local blobs**: `mocks/s3` stores objects in Postgres; production uses real S3 (ADR 0019).

**Connections**
- Each process has a bounded query pool. In production, pools may go through PgBouncer in
  **transaction mode**.
- Each process also holds **one dedicated direct connection** (never through a transaction-mode
  pooler) for `LISTEN`.
- pg-boss uses its own small pool (session semantics).
- Connection budgets per service are defined in ADR 0020.

App processes are stateless and horizontally scalable; in-process caches are only ever an
optimisation that can be dropped at any time.

**Not allowed:** Redis, Memcached, Kafka, external search engines, or any other stateful
service, unless a new ADR supersedes this one.

## Consequences
- NOTIFY payloads are tiny (tags/ids only) and never confidential: any role that can `LISTEN`
  can read them.
