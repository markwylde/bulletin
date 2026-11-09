# Spec Delta

## Purpose

Defines the ways plugins can change what the board shows and does, so a plugin can alter
almost anything without modifying core code or data.

## ADDED Requirements

### Requirement: Template fragments and overrides
Plugins SHALL inject template fragments at any registered hook point, or override a named fragment. Fragments SHALL follow the same safety rules as theme templates.

#### Scenario: Hide post count
- **WHEN** a plugin overrides the post-userbar fragment with a version without the post count
- **THEN** posts no longer show post counts, and the stored post counts are unchanged

### Requirement: View-model enrichers
Plugins SHALL add declared fields to a route's view model, computed with a 100 ms limit and cached with declared dependencies. A timed-out enricher SHALL leave its field empty.

#### Scenario: Enricher timeout
- **WHEN** an enricher takes longer than 100 ms
- **THEN** the page renders without that field

### Requirement: Write filters
Plugins SHALL transform content on save (in priority order) through filter hooks, within a total 300 ms budget per write. Filters that fail or time out SHALL be skipped.

#### Scenario: Filter failure
- **WHEN** a plugin filter throws on a new post
- **THEN** the post is saved without that filter's change, and the error is logged

### Requirement: Veto filters
Plugins holding the veto capability for a hook SHALL reject a write with a translated reason. Each veto SHALL be fail-open by default; admins MAY switch it to fail-closed.

#### Scenario: Fail-closed veto down
- **WHEN** an anti-spam plugin's veto is fail-closed and its sandbox is down
- **THEN** posts are rejected with a "temporarily unavailable" message

### Requirement: Event subscriptions
Plugins SHALL subscribe to any domain event type and receive each event at least once, independently of other subscribers.

#### Scenario: Plugin event
- **WHEN** a topic is created and a plugin subscribes to `topic.created`
- **THEN** the plugin receives the event with its IDs

### Requirement: Content extensions
Plugins SHALL add markdown syntax rendered at write time. Their output SHALL pass the core sanitiser.

#### Scenario: Unsafe extension output
- **WHEN** a content extension outputs a `<script>` element
- **THEN** the stored HTML does not contain it

### Requirement: Routes, jobs, permissions and settings
Plugins SHALL add themed pages under their own path, API endpoints under their own path, scheduled and queued jobs, group settings, forum actions and feature flags, all namespaced by plugin.

#### Scenario: Plugin forum action
- **WHEN** a plugin registers a forum action "can_tip"
- **THEN** it appears as a column in the forum permission matrix

### Requirement: Client apps
Plugins SHALL provide interactive client apps shown in sandboxed frames at hook points. The bridge SHALL let them resize, read the data their hook received, call their own plugin routes, open links and show toasts.

#### Scenario: Bridge call
- **WHEN** a plugin client app calls its own plugin route through the bridge
- **THEN** the call succeeds, with the viewer's identity applied by the core

### Requirement: Versioned SDK
The SDK SHALL be semantically versioned. Plugins built for the previous major version SHALL keep working through compatibility shims for one major release.

#### Scenario: Previous major
- **WHEN** a plugin built for SDK 1.x runs on a board with SDK 2.x
- **THEN** it loads and works through the shims, and the staff app warns that it uses a deprecated SDK
