# Tasks

## 1. Metrics and tracing

- [x] 1.1 Implement the metrics library and `/metrics` on every service with all listed metric families; integration test that a scrape returns each family
- [x] 1.2 Add OpenTelemetry tracing across apps, APIs, workers (job metadata propagation) and plugin-host; test that a reply produces one linked trace with an in-memory exporter

## 2. Health panel

- [ ] 2.1 Staff health panel (readiness, queue lag, dead letters, cache stats, variant warnings, plugin health, pool saturation) gated by `acp.system`; permission-denial test; E2E at 360 and 1440

## 3. Capacity

- [ ] 3.1 Implement the `SEED_SIZE=large` profile (1M posts) and verify it seeds deterministically
- [ ] 3.2 Implement the load test script with thresholds, and the nightly CI job; verify it fails on a planted latency regression

## 4. Backups and docs

- [ ] 4.1 Write `docs/ops/restore.md` (PITR, S3 versioning, reconciliation) and `docs/ops/deploy.md` (CDN requirements, PgBouncer transaction mode, direct LISTEN connections, connection budgets, plugin cluster option)
- [ ] 4.2 Implement the missing-object listing in the staff app and the reconciliation trigger after restore; integration test for the missing-object scenario
- [ ] 4.3 Implement the restore drill script for staging, and run it once
- [ ] 4.4 Erasure journal replay on restore (before readiness), with an integration test for the erasure-after-backup scenario

## 5. Strings

- [ ] 5.1 Add en/es/fr strings for the health panel and missing-object listing; verify completeness
