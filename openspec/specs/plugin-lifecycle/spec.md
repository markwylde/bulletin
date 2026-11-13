# plugin-lifecycle Specification

## Purpose
Lets admins add and manage functionality from the marketplace with one click, while every
step is verified, reversible where possible, and never leaves the board half-upgraded.

## Requirements

### Requirement: Marketplace browsing
Staff with `acp.plugins` SHALL browse the marketplace catalog with name, description, version, compatibility with the installed SDK, requested capabilities and author.

#### Scenario: Incompatible plugin
- **WHEN** a plugin requires a newer SDK major version than the board provides
- **THEN** it is shown as incompatible, and cannot be installed

### Requirement: Verified install with capability review
Installing SHALL verify the bundle signature and checksum, show every requested capability in plain language (including elevated data access and egress hosts), and require explicit approval. Installation SHALL NOT start without approval and recent authentication.

#### Scenario: Tampered bundle
- **WHEN** a downloaded bundle's checksum does not match the catalog
- **THEN** installation is refused, and nothing is changed

#### Scenario: Approve and install
- **WHEN** an admin approves the capabilities
- **THEN** the plugin's schema is migrated, its sandbox started, and its hooks active on the next request

### Requirement: Atomic upgrades
An upgrade SHALL pause the plugin, run all its migrations in one transaction, then start the new version. Old plugin code SHALL never run against the new schema. A migration failure SHALL restore the old version; an activation failure SHALL leave the plugin failed and disabled.

#### Scenario: Migration fails
- **WHEN** an upgrade's second migration fails
- **THEN** no migration is applied, and the old version is active again

#### Scenario: New version fails to start
- **WHEN** migrations succeed but the new version fails its health check
- **THEN** the plugin is marked failed and disabled, and admins are notified with a retry option

### Requirement: Disable takes effect immediately
Disabling a plugin SHALL, from the next request, remove its page fragments, enrichments, routes and client apps, stop its sandbox and pause its jobs. Its data SHALL be kept. Content it rendered earlier SHALL keep its sanitised output.

#### Scenario: Disable
- **WHEN** an admin disables a plugin that adds a badge to post userbars
- **THEN** the next page load shows no plugin badge

### Requirement: Uninstall
Uninstalling SHALL disable the plugin, run its data export or erasure hooks if requested, optionally drop its schema, and remove its settings, flags and permissions.

#### Scenario: Keep data
- **WHEN** an admin uninstalls a plugin and chooses to keep data
- **THEN** its schema remains, and reinstalling the same plugin restores its data

### Requirement: Automatic disable on repeated failure
A plugin whose hooks or jobs fail repeatedly beyond a threshold SHALL be disabled automatically, and admins SHALL be notified.

#### Scenario: Circuit breaker
- **WHEN** a plugin's enricher times out on 50 consecutive calls
- **THEN** it is disabled, and admins receive a notification naming the failing hook
