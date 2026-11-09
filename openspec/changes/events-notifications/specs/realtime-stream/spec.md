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
Streams SHALL validate the session at connect and at least every 60 seconds, and SHALL close immediately when the session is revoked.

#### Scenario: Logout elsewhere
- **WHEN** a member's sessions are revoked by staff
- **THEN** their open streams close, and the page shows them as logged out

### Requirement: Permission-filtered stream
Stream events SHALL carry only data the receiving viewer may see.

#### Scenario: Hidden forum activity
- **WHEN** a reply is posted in a forum a connected viewer cannot read
- **THEN** that viewer's stream receives nothing about it
