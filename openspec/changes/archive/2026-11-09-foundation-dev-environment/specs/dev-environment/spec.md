# Spec Delta

## Purpose

Defines how a developer gets a fully working, seeded Bulletin stack locally in two steps,
and how that stack behaves while they edit code.

## ADDED Requirements

### Requirement: Two-step startup
A fresh clone SHALL start the complete stack with `docker compose up --watch` and no other setup: no `.env` file, no host-installed tools besides a supported container engine, and no manual commands.

#### Scenario: Fresh clone starts
- **WHEN** a developer clones the repository and runs `docker compose up --watch` with a supported engine
- **THEN** all services become healthy, and `http://bulletin.localhost:8080` and `http://staff.bulletin.localhost:8080` respond

#### Scenario: Podman parity
- **WHEN** the same command runs with Podman ≥ 5 using `podman compose` with the Docker Compose v2 provider
- **THEN** the stack reaches the same healthy state as with Docker

### Requirement: No external network after first pull
Once images and packages have been pulled, the running stack SHALL make no requests to hosts outside the compose network.

#### Scenario: Offline operation
- **WHEN** the host network is disconnected after the first successful start, and the stack is restarted
- **THEN** all services become healthy and seeded pages render

### Requirement: Postgres is the only stateful service
The stack SHALL persist application state only in the Postgres volume, plus the darkauth-mock key volume required by the mock image.

#### Scenario: Volume inventory
- **WHEN** `docker compose config` is inspected
- **THEN** the only named volumes are the Postgres data volume and the darkauth-mock data volume

### Requirement: Migrations apply on start
API services SHALL apply pending SQL migrations on startup under a Postgres advisory lock. They SHALL refuse to start if an applied migration's checksum has changed.

#### Scenario: Concurrent starts
- **WHEN** user-api and staff-api start at the same time with a pending migration
- **THEN** the migration is applied exactly once and both services become ready

#### Scenario: Edited applied migration
- **WHEN** an already-applied migration file is modified
- **THEN** the service fails to start, with an error naming the file and the checksum mismatch

#### Scenario: New migration during watch
- **WHEN** a developer adds a migration file while the stack is running
- **THEN** the API services restart and apply it without manual action

### Requirement: Deterministic seed on empty database
When the database has no members, startup SHALL run all registered seed modules with a fixed random seed. The same commit SHALL always produce identical seed data.

#### Scenario: First start seeds
- **WHEN** the stack starts against an empty database
- **THEN** seed modules run once, and the seed completion is recorded

#### Scenario: Restart does not reseed
- **WHEN** the stack restarts with an already-seeded database
- **THEN** no seed module runs

#### Scenario: Reproducible data
- **WHEN** two empty databases are seeded from the same commit
- **THEN** their seeded rows are identical

### Requirement: Live code reload
Application services SHALL pick up source changes without rebuilding images. Dependency manifest changes SHALL trigger a rebuild.

#### Scenario: Source edit
- **WHEN** a developer edits a TypeScript file in an app or package
- **THEN** the affected service reflects the change within 5 seconds, without an image rebuild

#### Scenario: Dependency change
- **WHEN** `package.json` or `bun.lock` changes
- **THEN** compose rebuilds the affected images

### Requirement: Insecure defaults rejected in production
Every configuration variable SHALL have a working development default. Configuration validation SHALL reject development-only defaults when `NODE_ENV=production`.

#### Scenario: Production with dev secret
- **WHEN** a service starts with `NODE_ENV=production` and a dev-default secret
- **THEN** it exits with an error naming the variable
