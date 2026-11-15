# observability Specification

## Purpose
Lets operators see how the board is performing and spot problems before members do.

## Requirements

### Requirement: Metrics endpoint
Every service SHALL expose Prometheus metrics, including request latency per route, cache hit/miss/bypass rates, cache variant counts per route, queue depth and lag per queue, dead-letter counts, outbox publish lag, SSE connection counts, plugin hook timings and breaker trips, and database pool usage.

#### Scenario: Scrape
- **WHEN** the metrics endpoint is scraped
- **THEN** it returns each listed metric family

### Requirement: Distributed tracing
Requests and jobs SHALL produce traces spanning the user app, APIs, workers, plugin-host and database calls, exportable via OpenTelemetry when configured.

#### Scenario: Reply trace
- **WHEN** a reply is posted with tracing enabled
- **THEN** one trace links the request, the database transaction, the event relay and the notification job

### Requirement: Staff health panel
Staff with `acp.system` SHALL see a health panel with service readiness, queue lag, dead letters, cache hit rate and bypass time, variant cardinality warnings, plugin health and database pool saturation.

#### Scenario: Queue backlog
- **WHEN** a queue's lag exceeds 30 seconds
- **THEN** the panel highlights that queue

### Requirement: Capacity verified before release
A load test, run before each release, on the large seeded dataset SHALL verify the capacity targets (2,000 concurrent members, 20,000 concurrent guests, 50 writes per second), the page latency targets, queue lag under 5 seconds, and variant cardinality within budget.

#### Scenario: Regression detected
- **WHEN** a change makes cached guest pages exceed 30 ms p95
- **THEN** the load test fails and reports the route
