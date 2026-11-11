# Spec Delta

## Purpose

Shows members which topics and forums have new posts since they last read them, and takes
them straight to what is new.

## ADDED Requirements

### Requirement: Unread topics
For members, a topic SHALL be unread if it has a post newer than the member's read marker for that topic, or newer than their forum or board "mark read" time.

#### Scenario: New reply makes unread
- **WHEN** someone replies to a topic a member has fully read
- **THEN** the topic shows as unread for that member

### Requirement: Unread forums
A forum SHALL show as unread if it or any visible sub-forum contains an unread topic the member can read.

#### Scenario: Sub-forum unread
- **WHEN** only a sub-forum has an unread topic
- **THEN** both the sub-forum and its parent show as unread

### Requirement: Jump to first unread
Members SHALL be able to open a topic at its first unread post.

#### Scenario: First unread
- **WHEN** a member who read up to post 12 opens "first unread" on a 20-post topic
- **THEN** the topic opens at post 13

### Requirement: Mark as read
Members SHALL mark a single forum (including sub-forums) or the whole board as read.

#### Scenario: Mark all read
- **WHEN** a member marks the board as read
- **THEN** every forum and topic shows as read for them

### Requirement: Unread state is personal
Unread indicators SHALL be delivered only through the personal overlay, never in shared cached HTML. Guests SHALL see no unread indicators.

#### Scenario: Cached page
- **WHEN** two members load the same cached forum page
- **THEN** each sees only their own unread indicators
