# public-api Specification

## Purpose
Lets external tools read and write board content on behalf of a member or an integration,
with exactly the same permissions as that principal.

## Requirements

### Requirement: Versioned REST API
The board SHALL expose a REST API under `/api/v1` with a machine-readable OpenAPI description and human-readable documentation. Breaking changes SHALL only ship under a new version path.

#### Scenario: OpenAPI available
- **WHEN** a client requests `/api/v1/openapi.json`
- **THEN** it receives a valid OpenAPI document describing every endpoint

### Requirement: API key authentication only
`/api/v1` SHALL accept only API keys in the Authorization header. Session cookies SHALL be ignored there, and API keys SHALL be rejected on all other endpoints.

#### Scenario: Cookie ignored
- **WHEN** a browser with a session cookie calls `/api/v1/topics` without a key
- **THEN** the request is treated as a guest request

### Requirement: Keys act as a principal
Each key SHALL act as a member: personal keys as their creator, integration keys as a designated service member. A key's access SHALL never exceed its principal's permissions. Scopes SHALL further restrict it.

#### Scenario: Scope restriction
- **WHEN** a key with only `read:forums` calls the create-post endpoint
- **THEN** the API responds 403

#### Scenario: Principal limits
- **WHEN** an integration key with `read:topics` requests a topic in a forum its service member cannot read
- **THEN** the API responds 404

### Requirement: Key management
Members whose groups allow it SHALL create personal keys. Staff with `acp.api` SHALL create integration keys. Keys SHALL be shown once at creation, stored only as hashes, and support expiry, revocation and last-used display.

#### Scenario: Shown once
- **WHEN** a key is created
- **THEN** its full value is shown once, and afterwards only its prefix is visible

#### Scenario: Revoked key
- **WHEN** a revoked key is used
- **THEN** the API responds 401

### Requirement: Rate limits
Requests SHALL be rate-limited per key and per IP, with limits configurable by admins. Responses SHALL include remaining-quota headers, and exceeding the limit SHALL return 429 with a retry time.

#### Scenario: Over limit
- **WHEN** a key exceeds its per-minute limit
- **THEN** further requests receive 429 with `Retry-After`

### Requirement: Cross-origin use without credentials
`/api/v1` SHALL allow cross-origin requests from any origin without credentials.

#### Scenario: CORS
- **WHEN** a browser app on another origin calls `/api/v1` with an API key
- **THEN** the response allows the origin, and does not allow credentials
