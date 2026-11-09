## Why

Every checkout (main and each agent worktree) uses compose project `bulletin` and publishes port 8080.
Running `docker compose up` or `down` in one checkout replaces or removes another's stack, so a
maintainer's running stack can silently switch to an unmerged branch. Parallel stacks must coexist.

## What Changes

- The compose project name comes from `COMPOSE_PROJECT_NAME` (default `bulletin`).
- The published proxy port comes from `BULLETIN_HTTP_PORT` (default `8080`). All public origins,
  the DarkAuth issuer, redirect URIs, bootstrap admins, mock provider URLs and Caddy site addresses
  are derived from it, so a stack on another port is fully self-consistent.
- Tests and E2E derive their base URLs from the same variable (default 8080).
- README documents running a second stack, e.g. `COMPOSE_PROJECT_NAME=bulletin-agent BULLETIN_HTTP_PORT=18080`.
- The default two-step flow (clone, then the compose watch dev flow) is unchanged.

## Impact

- `compose.yaml`, `compose.test.yaml`, Caddyfile, `darkauth-mock.yaml` (or its env-driven replacement),
  mocks, tests, README.
- No ADR change: ADR 0002 and 0018 are preserved; origins stay separate hostnames.
