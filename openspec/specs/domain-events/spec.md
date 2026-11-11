# domain-events Specification

## Purpose
Provides a reliable, ordered-enough stream of everything that happens on the board, which
notifications, badges, webhooks and plugins can build on without losing or inventing events.

## Requirements

### Requirement: Events recorded atomically with changes
Every domain change in the event catalog SHALL record its event in the same transaction as the change. Rolled-back changes SHALL produce no event.

#### Scenario: Rolled back
- **WHEN** a reply fails validation after insertion and the transaction rolls back
- **THEN** no `post.created` event exists

### Requirement: At-least-once delivery per subscriber
Each event SHALL be delivered to every subscriber registered for its type at least once, with retries and backoff. Each subscriber SHALL track its own delivery independently.

#### Scenario: Subscriber failure isolated
- **WHEN** one subscriber fails on an event and another succeeds
- **THEN** only the failing subscriber retries it

#### Scenario: Relay crash
- **WHEN** the relay crashes after enqueuing deliveries but before marking the event published
- **THEN** after restart no delivery is duplicated for subscribers that deduplicate by event ID

### Requirement: Event payloads carry identifiers only
Event payloads SHALL contain identifiers, types, versions and timestamps, never content bodies or personal data. Subscribers SHALL load current state.

#### Scenario: Payload inspection
- **WHEN** a `post.created` event is inspected
- **THEN** it contains post, topic, forum and author IDs and the aggregate version, and no post text

### Requirement: Stale events are detectable
Each event SHALL carry the aggregate version after the change, so consumers can ignore events older than state they already processed.

#### Scenario: Out of order
- **WHEN** a consumer receives version 5 of a topic after already processing version 6
- **THEN** it can detect that version 5 is stale

### Requirement: Dead letters visible
Deliveries that exhaust retries SHALL be listed in the staff app with error details, and staff SHALL be able to retry them.

#### Scenario: Retry dead letter
- **WHEN** an admin retries a dead-lettered delivery after fixing the cause
- **THEN** it is delivered and removed from the dead-letter list
