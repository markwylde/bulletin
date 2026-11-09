# Spec Delta

## Purpose

Provides local, offline stand-ins for every external service Bulletin talks to, so that
development and tests never depend on third parties. Application code is identical for mock
and real services.

## ADDED Requirements

### Requirement: Mock per external service
The stack SHALL include a mock for each external dependency: identity (darkauth-mock), object storage (S3 API subset), SMTP, Web Push, plugin marketplace, webhook receiver, oEmbed/OpenGraph targets, and CDN.

#### Scenario: Mocks running
- **WHEN** the stack is healthy
- **THEN** each mock answers its health endpoint, and its inspection UI is reachable through the proxy

### Requirement: Same code path for mock and real services
Application code SHALL NOT branch on whether a dependency is mocked. Only configuration (URLs, credentials) SHALL differ.

#### Scenario: No mock branching
- **WHEN** the codebase is scanned by the architecture test
- **THEN** no application module references a mock-specific flag or hostname outside configuration defaults

### Requirement: Identity mock profiles
The darkauth-mock configuration SHALL define login profiles matching the seeded members for every seeded role. The roles are: admin, super moderator, forum moderator, member-specific moderator, regular members, new member, banned member, warned member, Spanish-locale member and French-locale member.

#### Scenario: Log in as seeded profile
- **WHEN** a developer chooses the "forum moderator" profile on the mock login page
- **THEN** they return to Bulletin logged in as the seeded forum moderator

### Requirement: S3 mock persists in Postgres
The S3 mock SHALL implement the operations Bulletin uses (put, get, head, delete, copy, list, presigned GET/PUT) and SHALL store objects in Postgres.

#### Scenario: Presigned upload round trip
- **WHEN** a client PUTs to a presigned URL issued against the mock, and then GETs the object
- **THEN** the bytes match, and the object survives a mock restart

### Requirement: Mail and push capture
The mail and push mocks SHALL capture every message they receive and display it in a web inbox, newest first, with the full payload.

#### Scenario: Email captured
- **WHEN** Bulletin sends an email
- **THEN** it appears in the mail mock inbox with headers, text and HTML parts

### Requirement: Webhook mock verifies signatures
The webhook mock SHALL record received requests and SHALL show whether each signature is valid for its configured secret.

#### Scenario: Invalid signature flagged
- **WHEN** a request arrives with a tampered body
- **THEN** the mock UI marks it as signature invalid

### Requirement: CDN mock honours cache headers
The CDN mock SHALL act as a caching reverse proxy that honours `Cache-Control`, keys guest responses on the `bp` cookie value only, and supports purge by surrogate key.

#### Scenario: Purge by key
- **WHEN** a cached guest page tagged `forum:3` is purged by key `forum:3`
- **THEN** the next request for that page is a cache miss at the CDN mock
