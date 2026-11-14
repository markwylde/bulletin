# Production deployment guide

This guide covers what a production deployment needs beyond `docker compose up`. It follows these ADRs:

- 0003: Postgres-only state
- 0006: caching
- 0009: plugins
- 0018: origins
- 0019: storage
- 0020: operations

Backups and restores have their own runbook in [`restore.md`](restore.md).

## 1. Topology

| Service | Default replicas (v1 capacity target) | Notes |
|---|---|---|
| user-app | 2+ | SSR from `packages/domain`, read role `user_app`; serves the user origin |
| user-api | 2 | All user writes, SSE (`/api/stream`) |
| staff-app | 1 | Static SPA |
| staff-api | 1 | Staff origin API |
| workers | 2 | Outbox relay, pg-boss jobs, restore replay at startup |
| plugin-host | 1 | Privileged (nsjail); see section 6 |
| Postgres | 1 primary (8 vCPU / 32 GB) | WAL archiving on; see `restore.md` |

The four origins must be separate hosts (ADR 0018): user, staff, files (presigned S3), and plugins (sandboxed iframes). Cookies are host-only.

## 2. CDN requirements

A CDN sits in front of **user-app only**. It must support all of the following (ADR 0006):

1. **Guest-only caching.**
   - Never cache a request that carries the session cookie (`__Host-bl_session`) or an unlock grant cookie.
   - Bypass when `Authorization` is present.
   - Respect `Cache-Control: private, no-store`, which user-app sends on every personalised response.
2. **A cookie-value cache key.**
   - Key on the URL plus the **value of the `bp` cookie** (`<locale>.<theme>.<scheme>`), and nothing else.
   - Ignore every other cookie and header, including `Accept-Language`.
   - The reverse proxy in front of the CDN origin strips a `bp` value that does not match `^(en|es|fr)\.\d{1,6}\.(light|dark|system)$`. Do the same in the CDN's key function if it supports one, so junk values cannot fragment the cache.
3. **Honour `s-maxage` and `stale-while-revalidate`.** user-app sends `public, s-maxage=15, stale-while-revalidate=15`. The 30-second total is the documented maximum guest exposure after a revocation.
4. **Surrogate-key purge.**
   - user-app tags cacheable responses with `Surrogate-Key: forum:12 topic:345 …`.
   - Workers and user-api purge by key: `POST $BULLETIN_CDN_PURGE_URL` with `{"keys": ["topic:345", …]}`.
   - Point `BULLETIN_CDN_PURGE_URL` at a small adapter for your provider's API:
     - Fastly: surrogate-key purge.
     - Cloudflare: cache tags (map `Surrogate-Key` to `Cache-Tag`).
     - Akamai: cache tags.
   - The adapter must answer 2xx only after the provider accepted the purge. A failed purge is retried by a worker job.
5. **No caching for these paths:**
   - `/api/*`
   - `/api/stream` (SSE; also disable response buffering)
   - `/attachments/*`, except the guest 302 that user-app marks public
   - `/health/*`

The local `cdn` mock implements exactly this contract and is the reference.

## 3. Postgres connections

### Connection budget

Every service checks at startup that the sum of its declared shares fits `max_connections` minus a reserve of 10. If it does not, the service refuses to run. Declare replicas with `BULLETIN_REPLICAS`, for example `user-app=4,user-api=2,workers=2`.

Defaults per replica (ADR 0020):

| Service | Query pool | LISTEN (direct) | pg-boss |
|---|---|---|---|
| user-app | 10 | 1 | — |
| user-api | 10 | 1 | — |
| staff-api | 5 | 1 | — |
| workers | 5 | 1 | 10 |
| plugin-host broker | lazy, ≤ 2 per plugin, 20 total (semaphore) | — | 2 |

For example, 4 × user-app, 2 × user-api, 1 × staff-api, 2 × workers and 1 × plugin-host need:

- user-app: 4 × 11 = 44
- user-api: 2 × 11 = 22
- staff-api: 1 × 6 = 6
- workers: 2 × 16 = 32
- plugin-host: 1 × 22 = 22

That is 126 connections. Add the 10 reserve, and `max_connections` must be at least 136. Use 200 to leave room for administration and pgBackRest.

### PgBouncer in transaction mode

Query pools may go through PgBouncer in **transaction mode** (ADR 0003). Requirements:

- PgBouncer **1.21 or later** with `max_prepared_statements = 200`. Bun's SQL client uses protocol-level prepared statements.
- `pool_mode = transaction`, with `default_pool_size` sized from the budget above.
- Set `server_reset_query` empty. Bulletin sets nothing at session level on pooled connections.
- **Never route these through the transaction pooler:**
  - `LISTEN` (see below)
  - migrations (`MIGRATION_DATABASE_URL`, advisory locks)
  - pg-boss (`PG_BOSS_DATABASE_URL`, session-level advisory locks)

### Direct LISTEN connections

Each process holds **one dedicated direct connection** for `LISTEN` (ADR 0003). It wakes on:

- cache tag bumps
- SSE notifications
- the readiness heartbeat

A transaction-mode pooler drops `LISTEN` state between transactions. So when `DATABASE_URL` points at PgBouncer, set `LISTEN_DATABASE_URL` to Postgres itself (or to a PgBouncer pool in **session** mode).

| Variable | Points at | Used for |
|---|---|---|
| `DATABASE_URL` | PgBouncer (transaction mode) or Postgres | Query pool |
| `LISTEN_DATABASE_URL` | Postgres directly | `LISTEN` only; defaults to `DATABASE_URL` |
| `PG_BOSS_DATABASE_URL` | Postgres directly | pg-boss (workers) |
| `MIGRATION_DATABASE_URL` | Postgres directly, owner role | Migrations at startup |

Each service connects as its own login role: `user_app`, `user_api`, `staff_api`, `workers`, `plugin_host`. Keep those roles. Pool saturation is measured **per process**: each process names its query pool `bulletin/<service>/<process id>` (`application_name`) and reports it against its own pool size, so replicas sharing a role never add up past 100%. Do not override `application_name` in the connection URL.

## 4. Object storage

- An S3-compatible bucket, private, with **versioning and a 35-day noncurrent-version expiry** (see `restore.md`).
- `S3_ENDPOINT` is the internal endpoint. `S3_PUBLIC_ENDPOINT` is the files origin baked into presigned URLs; it must be a separate host from the user origin.
- Set CORS on the files origin to allow `PUT` from the user origin only, for direct uploads.
- Do not set lifecycle rules on `journal/` or `ops/`.

## 5. Observability

The local stack has no metrics or tracing backend (ADR 0020). Production wires these up.

- **Metrics.** Every service exposes Prometheus text on an **internal** port, `BULLETIN_METRICS_PORT` (default `9464`; `off` disables it). Scrape `http://<pod>:9464/metrics`. Never expose that port publicly. Families to alert on:
  - `bulletin_http_request_duration_seconds`: p95 per route against the ADR 0006 targets.
  - `bulletin_queue_lag_seconds`: warn above 30 s, page above 5 min.
  - `bulletin_dead_letters`: any increase.
  - `bulletin_outbox_publish_lag_seconds`.
  - `bulletin_cache_variants`: above 64 per route.
  - `bulletin_cache_untrusted_seconds_total`: rising means the tag listener is down.
  - `bulletin_db_pool_connections` against `bulletin_db_pool_max`: saturation.
  - `bulletin_plugin_breaker_trips_total`.
- **Tracing.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) to an OTLP/HTTP collector, plus `OTEL_EXPORTER_OTLP_HEADERS` if it needs auth. `OTEL_SERVICE_NAME` overrides the service name. W3C `traceparent` flows like this:
  - from the request into the write transaction;
  - into the outbox row;
  - through the relay into pg-boss job data;
  - into plugin-host calls.
  One reply is therefore one trace.
- **Health.**
  - `/health/live` is for liveness probes.
  - `/health/ready` is for load balancers. It checks:
    - database
    - migrations current
    - LISTEN connected
    - the erasure journal applied (after a restore)
  - Staff see everything in **Overview → System health** (`acp.system`). staff-api reads it from each service over the internal network. Configure it with `BULLETIN_HEALTH_TARGETS`, for example `user-app=http://user-app:4321,user-api=http://user-api:3001,workers=http://workers:3003,plugin-host=http://plugin-host:3004`. Append `|<metrics url>` or `|off` to override the metrics address.
- **Graceful drain.** Give pods a 30-second termination grace period. On SIGTERM:
  1. readiness fails;
  2. SSE streams close with a `retry:` hint;
  3. in-flight requests get 25 s to finish;
  4. pg-boss workers finish their current job.

## 6. Plugin host and the plugin cluster option

- plugin-host is the only privileged container. nsjail needs `SYS_ADMIN`, unconfined outer seccomp and writable cgroup v2. Its preflight refuses to run plugin code otherwise. Run it on dedicated nodes.
- Plugin schemas live in the main database by default. They are limited by statement timeouts, temp-table quotas and the broker's connection semaphore.
- For **hard availability isolation**, set `PLUGIN_DATABASE_URL` to a **separate Postgres cluster**. Plugin tables, broker connections and quota monitoring then move there. A misbehaving plugin can then not exhaust the main cluster's connections, I/O or WAL. Back up that cluster with the same 35-day PITR policy.

## 7. Capacity verification

A nightly CI job (`.github/workflows/nightly.yml`) runs on a dedicated self-hosted runner labelled `bulletin-load`. It:

1. seeds `SEED_SIZE=large` (1M posts);
2. runs `bun scripts/load-test.ts` with:
   - 20,000 guests
   - 2,000 members with SSE
   - 50 writes/s
3. fails when any of these is missed:
   - an ADR 0006 p95 target
   - queue lag under 5 s
   - the error budget
   - the per-route variant budget

The JSON and text reports are uploaded as artifacts. Run the same command against staging before a launch, scaled to its size.

## 8. Release checklist

- Migrations are expand/contract. A release must run against schema N and N−1, so roll the application before running a contracting migration.
- Run `bun run check` and the nightly load test, and confirm the latest restore drill passed.
- Purge the CDN only for tags the release changes. Theme and template releases bump their own tags.
