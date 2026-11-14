# Proposal

## Why

ADR 0020 sets operational requirements: backups with restore drills, observability, and
capacity targets proven by load tests. These need to exist before the first production
deployment and should grow alongside features.

## What Changes

- Metrics endpoint per service with the key metrics from ADR 0020, and OpenTelemetry tracing.
- System health and metrics panel in the staff app (queue lag, dead letters, cache hit rate, bypass time, variant cardinality, plugin health, DB pool saturation).
- Backup and restore runbook (WAL archiving, base backups, S3 versioning, reconciliation after restore), and a restore drill script.
- `SEED_SIZE=large` dataset and a nightly load test asserting capacity and latency targets.
- Production deployment guide (CDN requirements, PgBouncer mode, LISTEN connections, connection budgets).

## Capabilities

### New Capabilities
- `observability`: metrics, traces and the in-app health view.
- `backups`: backup, restore and post-restore reconciliation.

### Modified Capabilities
- None.

## Impact

- All services (metrics, tracing), staff-app health panel, `docs/ops/`, CI (nightly load test), seed (large profile).
