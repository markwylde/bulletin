# Bulletin

Bulletin is a community forum built as a Bun monorepo. The architecture is defined in
[`docs/adr/`](docs/adr/README.md); product scope lives in [`docs/features.md`](docs/features.md).

## Start

**Two steps, no `.env` file:**

1. Clone the repository.
2. Run:

   ```bash
   docker compose up --watch
   ```

The first start needs registry access to pull images and packages. After that, the stack runs
offline: every external service is replaced by a local mock in [`mocks/`](mocks/).

Open `http://bulletin.localhost:8080`.

For the development loop, the plugin sandbox and troubleshooting, see
[`docs/dev.md`](docs/dev.md).

### Supported engines

- **Docker** Engine with Compose v2 **≥ 2.24**.
- **Podman ≥ 5** using `podman compose` with the Docker Compose v2 provider.
  The Python `podman-compose` is not supported.

The local stack runs in containers; Bun is only needed to run tests and development tooling:

| Tool | Pinned version |
|---|---|
| Bun | **1.4.0** (`packageManager` and Docker images) |
| Postgres | **18.6-alpine** |
| Caddy | **2.11.9-alpine** |
| darkauth-mock | local Bun mock in `mocks/darkauth` |
| Chrome/Chromium (E2E) | required on the host or CI image; set `BUN_CHROME_PATH` if auto-detection fails |

## Origins and ports

Only the proxy port is published; it comes from `BULLETIN_HTTP_PORT` and defaults to **8080**.
Everything is routed by hostname through Caddy, and every public origin, the DarkAuth issuer
and its redirect origins are derived from that port:

| URL (default port) | Serves |
|---|---|
| `http://bulletin.localhost:8080` | user app; `/api/*` → user API |
| `http://staff.bulletin.localhost:8080` | staff app; `/api/*` → staff API |
| `http://files.bulletin.localhost:8080` | attachments and avatars |
| `http://plugins.bulletin.localhost:8080` | plugin iframe apps |
| `http://auth.bulletin.localhost:8080` | DarkAuth mock |

### Running a second isolated stack

Two checkouts can run at the same time. Give the second stack its own compose project (so it
gets separate containers and volumes) and its own published port:

```bash
COMPOSE_PROJECT_NAME=bulletin-agent BULLETIN_HTTP_PORT=18080 docker compose up --watch
```

Open `http://bulletin.localhost:18080`. The default stack on port 8080 keeps running unchanged.
Tests and E2E read the same variable, so run them in the second checkout's shell with the
variables exported:

```bash
export COMPOSE_PROJECT_NAME=bulletin-agent BULLETIN_HTTP_PORT=18080
docker compose up -d --wait
BULLETIN_INTEGRATION=1 bun run test:integration
bun run test:e2e
```

Never reuse the same `COMPOSE_PROJECT_NAME` on two ports: `docker compose down` in one checkout
would stop the other's containers.

All service health endpoints are available at `/health/live` and `/health/ready` on their
origin.

## Mocks and inspection UIs

Mocks are dev-only and must never be used in production. They share the `bulletin.localhost`
origin under `/_mocks/`:

| Mock | UI / API |
|---|---|
| S3 | `http://bulletin.localhost:8080/_mocks/s3/` |
| Mail | `http://bulletin.localhost:8080/_mocks/mail/` |
| Push | `http://bulletin.localhost:8080/_mocks/push/` |
| Webhooks | `http://bulletin.localhost:8080/_mocks/webhooks/` |
| oEmbed/OpenGraph | `http://bulletin.localhost:8080/_mocks/oembed/` |
| Marketplace | `http://bulletin.localhost:8080/_mocks/marketplace/` |
| CDN | inspector at `http://bulletin.localhost:8080/_mocks/cdn/__ui`; proxy at `/_mocks/cdn/` |
| DarkAuth | `http://auth.bulletin.localhost:8080/` |

Each mock exposes `/health` under its path (for example `/_mocks/mail/health`). The S3 mock uses
the local bucket `bulletin` with access key `bulletin` / secret `bulletin-secret`. Data lives in
Postgres and survives restarts.

## Seed data and reset

On an empty database the API services run migrations and then the deterministic base seed
(`SEED=42`, `SEED_SIZE=default`). Completion is recorded in `core.seed_runs`; a restart does not
reseed. Later changes grow the seed into the full forum dataset.

A full reset removes the Postgres and darkauth-mock volumes:

```bash
docker compose down -v
```

Use `docker compose down` to stop the stack while keeping data.

## Tests

```bash
bun install
bun run check                      # typecheck, Biome lint, unit tests
BULLETIN_INTEGRATION=1 bun run test:integration  # full-stack mock/origin/DarkAuth suites
bun run test:e2e                   # Bun.WebView smoke + locale tests; stack must be running
```

Database and integration tests run inside the test container, which has the migrated
`bulletin_template` database:

```bash
docker compose -f compose.yaml -f compose.test.yaml --profile test run --rm test
```

For a faster local database loop against a separately running Postgres:

```bash
TEST_DATABASE_URL=postgres://bulletin:bulletin@localhost:5432/postgres bun run test:db
```

E2E uses the installed Chrome/Chromium. If Bun cannot detect it, set `BUN_CHROME_PATH`. E2E
tests must run serially because Bun's Chrome backend is process-wide.

CI runs `bun run check`, the compose test service, and the full-stack E2E smoke job on both
Docker and Podman (see `.github/workflows/ci.yml`).

## Offline check

After the first successful start, all images and packages are local. To simulate an offline
restart, keep the stack on an internal Docker network:

```bash
docker compose down
cat > /tmp/bulletin-offline.yml <<'EOF'
services: {}
networks:
  default:
    internal: true
EOF
docker compose -f compose.yaml -f /tmp/bulletin-offline.yml up -d --pull never
```

All services should become healthy; the stack makes no outbound requests. If your engine does
not publish ports from internal networks (some Podman versions), check the proxy from inside
the network:

```bash
docker compose -f compose.yaml -f /tmp/bulletin-offline.yml exec -T user-api \
  bun -e 'const r = await fetch("http://proxy:" + (process.env.BULLETIN_HTTP_PORT ?? "8080") + "/", { headers: { host: "bulletin.localhost" } }); console.log(r.status)'
```

## Troubleshooting

- **`permission denied` or role login failures after pulling an older checkout**: reset the
  Postgres volume once with `docker compose down -v`; local role auth is configured at database
  initialisation.
- **Port 8080 already in use**: stop the other stack, or set `BULLETIN_HTTP_PORT` (and a
  different `COMPOSE_PROJECT_NAME`) for this one.
- **E2E cannot find a browser**: install Chrome/Chromium or set `BUN_CHROME_PATH`.
- **Changes not reloading**: `docker compose up --watch` must be running; infrastructure
  services (Postgres, Caddy) are intentionally not watched; darkauth-mock watches its source and config.
