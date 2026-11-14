# Design

## Context

ADR 0020. Locally there is no metrics stack (Postgres-only rule), so the staff health panel
reads in-process metrics and DB state directly.

## Goals / Non-Goals

**Goals:** production readiness and continuous capacity verification.

**Non-Goals:** shipping a Prometheus/Grafana stack in compose.

## Decisions

- **Metrics**: a minimal Prometheus text exposition library in `packages/config/metrics`
  (counters, gauges, histograms). Each service exposes `/metrics` on an internal port.
- **Tracing**: `@opentelemetry/api` with an OTLP HTTP exporter, enabled by env. W3C
  `traceparent` is propagated via job metadata for pg-boss, and via headers to plugin-host.
- **Health panel**: staff-api aggregates `/health/ready` of each service over the internal
  network, plus `pgboss` queue stats, plus each process's metrics snapshot.
- **Load test**: a Bun script with worker threads simulating guests (CDN bypassed for origin
  measurement, and with the CDN mock for end-to-end), members (overlay, SSE) and writers.
  Runs nightly on a dedicated runner against `SEED_SIZE=large` (1M posts). Thresholds are
  asserted, and results published as a CI artifact.
- **Backups**: documented for managed Postgres (PITR) and self-hosted (pgBackRest) in
  `docs/ops/restore.md`. The drill script has two modes: a local mode that the nightly CI job
  runs against a disposable compose stack (logical backup, restore over the database,
  automatic post-restore, smoke tests), and a staging mode that drives the provider's restore
  through an operator-supplied command for the quarterly drill.

### Implementation notes

- **Metrics port**: `/metrics` is served on a separate internal listener
  (`BULLETIN_METRICS_PORT`, default 9464, `off` disables), never on the public port. Pool
  saturation is read from `pg_stat_activity` for the service's own login role.
- **Trace propagation**: `traceparent` is stored on the outbox row (`core.events.trace_parent`)
  so the relay continues the writer's trace, then travels in pg-boss job data. The SDK is a
  small in-repo implementation on `@opentelemetry/api` (in-memory and OTLP/HTTP exporters).
- **Health targets**: staff-api reads `BULLETIN_HEALTH_TARGETS` (`name=url[|metricsUrl|off]`).
- **Capacity seed**: generated set-based from series indexes against a fixed anchor time, so
  it is deterministic; it adds a `load_writers` secondary group (flood control 0, `min` merge)
  for the seeded load-test writers only.
- **Load test**: `packages/test-utils/src/load-test.ts` (worker threads, 0.1 ms latency
  buckets, metrics scrape for queue lag and variants); `compose.loadtest.yaml` publishes the
  metrics ports on loopback for the nightly run.
- **Restore detection**: workers keep `ops/watermark.json` (the outbox sequence) in object
  storage; a database behind it was restored. Startup then replays the erasure journal,
  reconciles storage and rebuilds `core.missing_objects` before any job starts.
- **Journal replay before readiness**: the erasure job records the journal key in
  `core.erasure_journal_applied` before writing the entry and `journal/HEAD`. user-api (and so
  user-app, whose readiness proxies it) and staff-api fail `/health/ready` until HEAD is
  applied. `pii.replay_erasure` recreates the request when the restore point predates it and
  re-revokes the journalled sessions, API keys and push devices; the normal job then runs.
- **Bucket versioning**: the S3 mock keeps noncurrent versions and delete markers for 35 days
  (`ListObjectVersions`, `GetObject?versionId`, copy-source `?versionId`); the storage client
  gained `listVersions` and `restoreVersion`.
- **Direct LISTEN**: `LISTEN_DATABASE_URL` (default `DATABASE_URL`) gives each process a
  dedicated LISTEN client so query pools can go through PgBouncer in transaction mode (ADR 0003).

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| `core.missing_objects.resource_id`, `storage_key` | derived | Tell staff which attachment/avatar objects a restore lost; explain the download error | Rebuilt by every post-restore scan; removed once the object exists again | `acp.system` staff; user-app reads only to answer the owner's/reader's download | Not exported | Deleted in the erasure job's attachments step |
| `core.erasure_journal_applied` | not personal | Which journal entries this database applied (key, request ID) | Kept with the request rows | workers write; services read for readiness | — | — (IDs only, no member ID) |
| Erasure journal entry (`journal/…`) | restricted IDs | Re-apply erasures after a restore (ADR 0012) | 35-day bucket versioning; entries kept while backups may predate them | workers only | — | Is itself the erasure record; adds `postAction` |
| `core.events.trace_parent`, trace spans | not personal | Request tracing | Outbox retention | internal | — | — (random IDs; spans carry route patterns, never URLs with IDs or user data) |
| Metrics | not personal | Operations | Scrape retention | internal port only | — | — (labels are route patterns, queues, services) |
| Load-test sessions | not personal | Capacity test on dev/staging only (seeded subjects) | Session expiry | — | — | — |

## Risks / Trade-offs

- [Load test cost] → nightly only, on a dedicated runner.

## Feature flags (ADR 0010)

None: staff-only tooling and operations, exempt under ADR 0010.
