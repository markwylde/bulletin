# Spec Delta

## Purpose

Defines how every Bulletin service reports its health, shuts down without dropping work,
and stays within its database connection budget.

## ADDED Requirements

### Requirement: Liveness and readiness endpoints
Every service SHALL expose `/health/live` and `/health/ready`. Readiness SHALL be true only when the database is reachable, migrations are current, and the notification listener is connected.

#### Scenario: Database down
- **WHEN** Postgres becomes unreachable
- **THEN** `/health/ready` returns 503 while `/health/live` still returns 200

#### Scenario: Ready
- **WHEN** all dependencies are available
- **THEN** `/health/ready` returns 200 with a JSON body listing each check as passing

### Requirement: Graceful drain on SIGTERM
On SIGTERM a service SHALL fail readiness, stop accepting new connections, close streams with a retry hint, finish in-flight requests and jobs within 25 seconds, then exit.

#### Scenario: In-flight request completes
- **WHEN** SIGTERM arrives while a request is being processed
- **THEN** the request completes successfully and the process exits afterwards

#### Scenario: Drain timeout
- **WHEN** in-flight work is still running 25 seconds after SIGTERM
- **THEN** the process exits, and any unfinished jobs are retried by another worker

### Requirement: Connection budget enforcement
At startup each service SHALL compare its configured connection usage (pool, listener and queue) times declared replicas across all services against the database's `max_connections` minus a reserve, and SHALL refuse to start if the budget is exceeded.

#### Scenario: Over budget
- **WHEN** configured pools across services exceed the available connections
- **THEN** the service exits with an error listing each service's share

### Requirement: Structured redacted logs
Services SHALL log JSON lines with a request or job ID, and SHALL redact email addresses, IP addresses and tokens.

#### Scenario: Redaction
- **WHEN** a log call includes an email address in a message or field
- **THEN** the emitted line contains a redaction marker instead of the address
