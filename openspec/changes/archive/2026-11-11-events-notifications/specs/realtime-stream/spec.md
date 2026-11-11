# Spec Delta

## Purpose

Keeps open pages current (counts, new replies, revoked sessions) without reloading, while
respecting permissions and recovering cleanly from disconnects.

## ADDED Requirements

### Requirement: Live counts
While a member has a page open, their notification, message and (for moderators) moderation-queue counts SHALL update within 5 seconds of a change.

#### Scenario: New notification
- **WHEN** a member receives a notification while viewing a page
- **THEN** the bell count increases within 5 seconds without a reload

### Requirement: New replies banner
A viewer on a topic's last page SHALL see a banner when new posts they can read are added, and clicking it SHALL load them.

#### Scenario: Banner
- **WHEN** someone replies while a member is on the topic's last page
- **THEN** a "1 new reply" banner appears, and clicking it shows the reply

### Requirement: Replay after reconnect
After a disconnect, the stream SHALL resume from the last received event when possible. Otherwise it SHALL instruct the client to resynchronise its counts.

#### Scenario: Short disconnect
- **WHEN** the connection drops for 10 seconds and reconnects with its last event ID
- **THEN** events from the gap are delivered

#### Scenario: Long disconnect
- **WHEN** the gap exceeds what can be replayed
- **THEN** the client receives a resync instruction and refreshes its counts

### Requirement: Session enforcement on streams
Streams SHALL validate the session at connect and at least every 60 seconds. On revocation the stream SHALL send a `session_revoked` event and close. When the session passes its background re-auth grace, the stream SHALL send a `reauth_required` event and close.

#### Scenario: Logout elsewhere
- **WHEN** a member's sessions are revoked by staff
- **THEN** their open streams receive `session_revoked` and close, and the page shows them as logged out

#### Scenario: Re-auth grace expires
- **WHEN** an open stream's session passes its re-auth grace period
- **THEN** the stream receives `reauth_required` and closes, and the client keeps unsaved editor content and offers to continue

### Requirement: Control event names
The stream SHALL use these fixed event names for control messages: `resync` (replay gap too large), `session_revoked` and `reauth_required`. Clients SHALL handle all three, and the names SHALL be part of the versioned client contract.

#### Scenario: Unknown gap
- **WHEN** a client reconnects with a last event ID older than the replay window
- **THEN** the first event it receives is named `resync`

### Requirement: Permission-filtered stream
Stream events SHALL carry only data the receiving viewer may see.

#### Scenario: Hidden forum activity
- **WHEN** a reply is posted in a forum a connected viewer cannot read
- **THEN** that viewer's stream receives nothing about it
