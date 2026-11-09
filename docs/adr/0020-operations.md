# 0020 — Operations: backups, health, observability and capacity

**Status:** Accepted

## Decision
### Backups and restore
- Postgres: continuous WAL archiving plus nightly base backups, giving point-in-time recovery.
  The retention window is 35 days (ADR 0012).
- S3: bucket versioning with a 35-day noncurrent-version expiry.
- **Consistency**: the DB is authoritative. After a restore, the reconciliation job (ADR 0019)
  removes objects not referenced by the DB. Rows referencing missing objects are flagged in
  the staff app.
- A **restore drill** runs quarterly in staging, with a documented runbook in `docs/ops/restore.md`.

### Process lifecycle
- Each service exposes `/health/live` and `/health/ready`. Ready means DB reachable, migrations
  current, and LISTEN connected.
- **Graceful drain** on SIGTERM:
  1. readiness fails,
  2. the process stops accepting new connections,
  3. SSE streams close with a `retry:` hint,
  4. in-flight requests finish (≤ 25 s),
  5. pg-boss workers stop fetching and finish their current jobs.
- Migrations are serialised by advisory lock (ADR 0002), and app versions must be compatible
  with schema N and N-1 (expand/contract migrations).

### Connection budget (defaults, per replica)
| Service | Pool | LISTEN | pg-boss |
|---|---|---|---|
| user-app | 10 | 1 | — |
| user-api | 10 | 1 | — |
| staff-api | 5 | 1 | — |
| workers | 5 | 1 | 10 |
| plugin-host broker | 2 per plugin, max 20 total | — | 2 |

These are configurable, and a startup check refuses to run if the sum across declared
replicas exceeds `max_connections` minus a reserve.

### Observability
- Structured JSON logs (redacted per ADR 0012) and OpenTelemetry traces.
- A Prometheus `/metrics` endpoint per service.
- Key metrics:
  - p50/p95 latency per route
  - cache hit rate, `BYPASS` and `untrusted` time, and **variant cardinality per route**
  - queue depth and lag per queue, and dead-letter count
  - outbox publish lag
  - SSE connections
  - plugin hook timings and breaker trips
  - DB pool saturation
- Local compose includes **no** observability stack (Postgres-only rule). The metrics endpoints
  exist; production wires them up.

### Capacity targets (v1)
- 2,000 concurrent members, 20,000 concurrent guests, 50 writes/s sustained, and 1M posts in
  the DB, on 2× user-api, 1× staff-api, 2× workers and a single Postgres (8 vCPU/32 GB).
- A load test (`bun` script plus the seeded large dataset profile `SEED_SIZE=large`) runs
  nightly in CI. It asserts the ADR 0006 latency targets, queue lag < 5 s, and variant
  cardinality within budget.

## Consequences
- Production deployment needs WAL archiving, a metrics stack and a CDN with cookie-value cache
  keys and surrogate-key purge. These are documented in `docs/ops/`.
