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
- **Backups**: documented for managed Postgres (PITR) and self-hosted (pgBackRest). The drill
  script uses the staging environment API, and is not part of local compose.

## Risks / Trade-offs

- [Load test cost] → nightly only, on a dedicated runner.

## Feature flags (ADR 0010)

None: staff-only tooling and operations, exempt under ADR 0010.
