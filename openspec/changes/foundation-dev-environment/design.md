# Design

## Context

Greenfield repository. Architecture constraints: ADR 0001 (layout, Bun-first), 0002 (two
steps, mocks), 0003 (Postgres only), 0015 (testing), 0018 (origins), 0020 (health,
budgets). Atlas (`../atlas`) shows the working darkauth-mock compose pattern.

## Goals / Non-Goals

**Goals:**
- Every app and package exists as a buildable shell, wired into compose, watch and CI.
- Test infrastructure that later changes only extend.

**Non-Goals:**
- Any forum feature, login, or UI beyond a placeholder page per app.

## Decisions

- **One Dockerfile per app, using a multi-stage `oven/bun:<pinned>` image.** Dev targets run
  `bun --watch`, and compose `develop.watch` syncs `apps/<x>/src` and `packages/*/src`.
  *Alternative:* a single shared dev image for all apps. Rejected because per-app rebuild
  triggers would be coarser.
- **Caddy as proxy** with host-based routing for the ADR 0018 hostnames on port 8080.
  *Alternative:* Traefik. Rejected because Caddy's config is simpler and needs no labels.
- **Migration runner in `packages/db`**: it reads `migrations/NNNN_name.sql` in order, stores
  `(name, sha256, applied_at)` in `core.schema_migrations`, runs each file in its own
  transaction, and holds `pg_advisory_lock(hashtext('bulletin.migrate'))` throughout.
- **Seed framework**: `packages/db/seed` registers modules with `dependsOn`. A seeded RNG
  (mulberry32, from env `SEED`, default 42) is passed to each module. Completion is recorded
  in `core.seed_runs`. `SEED_SIZE=small|default|large` controls volume.
- **Test databases**: a global test setup migrates `bulletin_template`. Each test file
  `CREATE DATABASE … TEMPLATE bulletin_template` and drops it afterwards.
- **E2E helpers** wrap `Bun.WebView` with the Chrome backend, a temp profile per test,
  viewport presets (360×780, 390×844, 1440×900), `loginAs(profile)` via the mock login page,
  and `waitForHydration()`.
- **Mocks** are small `Bun.serve` apps in `mocks/<name>`, sharing a tiny UI kit. Each takes a
  YAML or env config. The S3 mock implements SigV4 presign verification for the operations
  used.
- **CI** (GitHub Actions or Gitea Actions, depending on the remote): `bun run check`, then the
  compose-based E2E job on both Docker and Podman runners.

## Risks / Trade-offs

- [`Bun.WebView` is experimental] → pin Bun; keep the helpers thin so a swap only touches `packages/test-utils`.
- [Podman watch differences] → CI matrix on Podman; document the provider requirement.
- [S3 mock incompatibility with real S3] → contract tests run the same suite against the mock
  and, optionally, real S3 via env.

## Migration Plan

Not applicable (greenfield).
