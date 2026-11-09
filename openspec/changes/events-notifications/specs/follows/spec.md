# Spec Delta

## Purpose

Lets members subscribe to topics, forums and other members so they hear about new activity.

## ADDED Requirements

### Requirement: Follow topics, forums and members
Members SHALL follow and unfollow topics and forums they can read, and other members. They SHALL see and manage all their follows on one page.

#### Scenario: Follow a forum
- **WHEN** a member follows a forum
- **THEN** new topics in that forum generate notifications for them

#### Scenario: Manage follows
- **WHEN** a member opens their follows page
- **THEN** they see every followed topic, forum and member, and can unfollow each

### Requirement: Auto-follow on participation
Members SHALL be able to choose to automatically follow topics they start or reply to. It SHALL be on by default.

#### Scenario: Auto-follow reply
- **WHEN** a member with auto-follow replies to a topic
- **THEN** they now follow that topic

### Requirement: Follow state is personal
Follow buttons SHALL show the viewer's state via the personal overlay, never in shared cached output.

#### Scenario: Cached topic page
- **WHEN** a follower and a non-follower load the same cached topic page
- **THEN** each sees their own follow state

### Requirement: Follows of inaccessible content are inert
Follows of content the member can no longer read SHALL produce no notifications, and SHALL be shown as unavailable on the follows page.

#### Scenario: Forum hidden
- **WHEN** a followed forum becomes hidden to a member
- **THEN** they receive no notifications from it, and the follows page lists it as unavailable
