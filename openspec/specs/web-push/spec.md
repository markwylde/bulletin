# web-push Specification

## Purpose
Delivers notifications to members' devices even when the forum isn't open, without putting
forum content into third-party push services.

## Requirements

### Requirement: Opt-in per device
Members SHALL enable push per device from their notification settings, and SHALL see and remove their registered devices.

#### Scenario: Enable on phone
- **WHEN** a member enables push on their phone and grants browser permission
- **THEN** the device appears in their device list

#### Scenario: Remove a device
- **WHEN** a member removes a device from their list
- **THEN** that device receives no further pushes, and the list shows only labels and dates, never push endpoints or keys

### Requirement: Per-type push preferences
Push SHALL be a channel in the notification preferences, selectable per notification type.

#### Scenario: Only PMs
- **WHEN** a member enables push only for private messages
- **THEN** a new PM triggers a push, and a reaction does not

### Requirement: Content-free payloads
Push payloads SHALL contain only a notification reference and a generic translated title (such as "New reply"). Details SHALL be fetched by the device after authenticating.

#### Scenario: Payload inspection
- **WHEN** a push for a reply is captured
- **THEN** it contains no post text, topic title or member names

### Requirement: Authorisation at send time
Pushes SHALL be sent only if the recipient can read the referenced content at send time, consistent with all other notification channels.

#### Scenario: Access lost
- **WHEN** a member loses access to a forum before a push about it is sent
- **THEN** no push is sent

### Requirement: Open on click
Clicking a push SHALL open the referenced page, or the login page if the device's session has ended.

#### Scenario: Click
- **WHEN** a member taps a "New reply" push
- **THEN** the app opens at the reply

### Requirement: Dead subscriptions removed
Subscriptions rejected by the push service as expired or invalid SHALL be removed automatically.

#### Scenario: Gone
- **WHEN** the push service responds 410 for a subscription
- **THEN** the subscription is deleted
