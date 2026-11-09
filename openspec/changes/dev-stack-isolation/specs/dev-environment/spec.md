## ADDED Requirements

### Requirement: Isolated parallel stacks
The dev stack SHALL take its compose project name from `COMPOSE_PROJECT_NAME` (default `bulletin`) and its published HTTP port from `BULLETIN_HTTP_PORT` (default `8080`), deriving every public origin, the identity issuer and redirect URIs from that port, so that two checkouts can run full stacks at the same time without affecting each other.

#### Scenario: Default stack unchanged
- **WHEN** a developer starts the stack with no overrides
- **THEN** the project is named `bulletin` and the forum is served at `http://bulletin.localhost:8080`

#### Scenario: Second stack on another port
- **WHEN** a second checkout starts the stack with `COMPOSE_PROJECT_NAME=bulletin-agent` and `BULLETIN_HTTP_PORT=18080`
- **THEN** the forum, staff console and login work at `http://bulletin.localhost:18080`
- **AND** the first stack on port 8080 keeps running unchanged
