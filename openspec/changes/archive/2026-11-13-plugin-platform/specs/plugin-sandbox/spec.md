# Spec Delta

## Purpose

Guarantees that third-party plugin code cannot read or change core or personal data beyond
what an admin granted, cannot act as a viewer, and cannot take the board down.

## ADDED Requirements

### Requirement: Isolated server execution
Each plugin's server code SHALL run in its own sandbox with no network access, no access to other plugins' files, no environment secrets, and CPU, memory, process and time limits. All I/O SHALL go through the broker.

#### Scenario: Network attempt
- **WHEN** plugin code opens a TCP connection to any host
- **THEN** the connection fails

#### Scenario: Fork bomb
- **WHEN** plugin code spawns processes in a loop
- **THEN** it hits the process limit and is killed, and the board keeps serving pages

### Requirement: Own schema only
A plugin's database access SHALL be limited to reading and writing rows in its own schema at runtime. Creating objects SHALL happen only through its migrations. It SHALL have no access to core, personal-data, queue or other plugins' schemas, and SHALL NOT listen to database notifications.

#### Scenario: Read core table
- **WHEN** a plugin runs `SELECT * FROM core.members`
- **THEN** the query fails with a permission error

#### Scenario: Runtime DDL
- **WHEN** a plugin runs `CREATE TABLE` outside a migration
- **THEN** the statement fails

### Requirement: Database resource limits
Plugin queries SHALL be limited in duration, memory, temporary files, concurrency and rate. A plugin exceeding its storage quota SHALL lose write access until an admin acts. Admins SHALL be warned when untrusted plugins share the core database cluster in production.

#### Scenario: Storage quota
- **WHEN** a plugin's schema grows beyond its 1 GB quota
- **THEN** within a minute its inserts and updates fail, and admins are alerted

### Requirement: Egress allowlist
Plugin HTTP requests SHALL be possible only through the broker, only to hosts declared in the manifest and approved, and never to private or internal addresses.

#### Scenario: Undeclared host
- **WHEN** a plugin requests a host not in its manifest
- **THEN** the broker refuses the request

### Requirement: Viewer-context access is intersected
When plugin code runs to serve a viewer (fragments, enrichers, routes, client app calls), core data access SHALL be limited to what both the plugin and the viewer may access.

#### Scenario: Privileged plugin, guest viewer
- **WHEN** a plugin with elevated read access renders an enricher for a guest
- **THEN** its core data calls return only guest-readable content

### Requirement: Background access defaults to public
A plugin's background identity SHALL default to Guests-level access. Elevated access SHALL require an explicit admin grant that names the forums, with a warning that the plugin may display or repost that content to anyone.

#### Scenario: Grant elevated access
- **WHEN** an admin grants a plugin read access to "Staff Lounge"
- **THEN** the staff app shows the warning and records the grant in the admin log

### Requirement: Client code isolation
Plugin browser code SHALL run only in sandboxed frames on the plugin origin, without access to forum cookies, the page or the viewer's session, and SHALL communicate only through a validated message bridge.

#### Scenario: Cookie access
- **WHEN** plugin client code reads `document.cookie` or calls the forum API directly
- **THEN** it has no forum cookies, and the API treats the request as unauthenticated

### Requirement: Adversarial test suite
The project SHALL maintain a suite of malicious plugins that attempt each escape (core and PII reads, notifications, sockets, fork bombs, memory exhaustion, sibling files, environment, `/proc`, bridge abuse). The suite SHALL pass on Docker and Podman.

#### Scenario: Suite in CI
- **WHEN** CI runs the malicious-plugin suite
- **THEN** every attempt is blocked, and the build passes on both engines

### Requirement: No privileged read-through
A plugin acting for a viewer SHALL read only what both the viewer and the plugin's service principal may read.

#### Scenario: Staff viewer, guest-level plugin
- **WHEN** a plugin whose service principal is Guests serves an enricher during an admin's request for a staff-only topic
- **THEN** the plugin receives none of the staff-only content

### Requirement: Database side effects contained
Plugin SQL SHALL NOT change session settings, signal other processes, take advisory locks, sleep, or exceed its deadline, whether directly, through built-in functions, or through functions it created.

#### Scenario: Forged notification
- **WHEN** a plugin runs `SELECT pg_notify('session_revoked', '1')`
- **THEN** the statement is rejected and no notification is delivered
