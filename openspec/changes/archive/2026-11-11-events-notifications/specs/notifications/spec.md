# Spec Delta

## Purpose

Tells members about activity relevant to them, in the app and by email, in a way they
control. It never reveals content they can no longer see.

## ADDED Requirements

### Requirement: Notification types
Members SHALL receive notifications for: replies in followed topics, new topics in followed forums, new topics or posts by followed members, mentions, quotes of their posts, new private messages, group promotions, badges, warnings, and moderation outcomes on their content or reports.

#### Scenario: Mention notification
- **WHEN** a member is mentioned in a post they can read
- **THEN** they receive a mention notification linking to the post

### Requirement: Authorisation at delivery
Before delivering any notification on any channel, the system SHALL verify the recipient can currently read the referenced content. Undeliverable notifications SHALL be dropped silently.

#### Scenario: Access lost before delivery
- **WHEN** a member loses access to a forum after a reply was posted but before the notification is sent
- **THEN** no notification is delivered

### Requirement: In-app notification centre
Members SHALL see an unread notification count on every page, open a list grouped by recency, open a notification (marking it read), and mark all as read.

#### Scenario: Mark all read
- **WHEN** a member marks all notifications as read
- **THEN** the unread count becomes zero

### Requirement: Preferences per type and channel
Members SHALL choose, per notification type, whether to receive it in-app, by email immediately, in a digest, or not at all.

#### Scenario: Email off for reactions
- **WHEN** a member disables email for reactions
- **THEN** reactions to their posts produce in-app notifications only

### Requirement: Email notifications
Email notifications SHALL be localised to the recipient, contain only content the recipient can read, exclude quoted text, and include a one-click unsubscribe for that type.

#### Scenario: Unsubscribe link
- **WHEN** a member clicks the unsubscribe link in a reply notification email and confirms
- **THEN** email for that notification type is disabled without logging in

#### Scenario: Link scanner
- **WHEN** an email security scanner fetches the unsubscribe link with GET
- **THEN** nothing changes

#### Scenario: Digest with notifications off
- **WHEN** the `notifications` flag is off and a member's weekly digest is due
- **THEN** the digest is still delivered to their address

### Requirement: Digests
Members SHALL be able to receive a daily or weekly digest summarising activity in followed topics and forums since the last digest. Digests SHALL be built at send time with current permissions.

#### Scenario: Weekly digest
- **WHEN** a member opted into weekly digests and the weekly schedule runs
- **THEN** they receive one email listing new activity they can read

### Requirement: Notification coalescing
Multiple notifications of the same type about the same topic that are not yet read SHALL be combined into one entry with a count.

#### Scenario: Several replies
- **WHEN** 5 replies arrive in a followed topic before the member checks notifications
- **THEN** they see one entry, "5 new replies in …"
