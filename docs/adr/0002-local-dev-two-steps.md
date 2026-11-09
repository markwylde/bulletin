# 0002 — Local development: clone, then `docker compose up --watch`

**Status:** Accepted (revised after review)

## Context
Onboarding must be trivial. Podman is used locally.

## Decision
- Local setup is exactly two steps:
  1. `git clone …`
  2. `docker compose up --watch`
- **Offline promise**: once images and packages have been pulled the first time, the stack
  needs **no external network or third-party service**. The first run needs registry access.
- **Supported engines** (pinned in `README.md`): Docker Engine + Compose v2 ≥ 2.24, and Podman
  ≥ 5 using `podman compose` with the Docker Compose v2 provider. `podman-compose` (Python)
  is not supported because `develop.watch` behaviour differs. CI runs on both engines.
- No `.env` required: every variable has a working dev default in `compose.yaml`. Insecure dev
  defaults are clearly labelled and rejected by `packages/config` when `NODE_ENV=production`.
- **Application services** (built from this repo) use `develop.watch`: `sync` for source,
  `sync+restart` for migrations/config, `rebuild` for `package.json`/lockfile.
  **Infrastructure services** (Postgres, darkauth-mock, proxy) are image-only and not watched.
- **Migrations**: every API service runs `migrate` on startup inside a Postgres advisory lock
  (`pg_advisory_lock`), so concurrent starts serialise and re-runs are no-ops. Changing a
  migration file triggers `sync+restart` of the APIs, which applies it. Migrations are
  forward-only. Editing an already-applied migration fails loudly with a checksum mismatch.
- **Seed**: after migrations, if the DB is empty, a deterministic seed (fixed RNG seed) creates
  a **well-populated** board: ~15 forums across categories and sub-forums (including a
  password forum and a redirect forum), every group type, thousands of topics/posts with
  realistic markdown, polls, attachments, reactions, reputation, badges, warnings, reports,
  PMs, announcements, follows, sample plugins, two themes, flags, and en/es/fr content.
- **All external services are mocked** in `mocks/`, following the darkauth-mock pattern
  (small Bun service, app-agnostic, config-driven, with an inspection UI):
  | Service | Mock | Purpose |
  |---|---|---|
  | DarkAuth | `ghcr.io/puzed/darkauth-mock` + `darkauth-mock.yaml` | OIDC login, pick a profile |
  | S3 | `mocks/s3` | S3-compatible subset, blobs stored in Postgres |
  | SMTP | `mocks/mail` | captures email, web inbox |
  | Web Push | `mocks/push` | captures push payloads |
  | Marketplace | `mocks/marketplace` | signed plugin/theme registry serving seed packages |
  | Webhook sink | `mocks/webhooks` | receives and displays webhooks, verifies signatures |
  | Unfurl targets | `mocks/oembed` | canned OpenGraph/oEmbed responses |
  | CDN | `mocks/cdn` | caching reverse proxy that honours our cache headers and purge API |
- App code never branches on "mock vs real": only URLs/credentials differ via env.
- Hostnames and routing are defined in ADR 0018. Entry point:
  `http://bulletin.localhost:8080`.

## Consequences
- Any new external integration must ship with a mock in the same PR.
- `docker compose down -v` is a full reset.
