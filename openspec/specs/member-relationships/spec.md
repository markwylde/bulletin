# member-relationships Specification

## Purpose
Lets members control who they interact with: ignoring people they don't want to hear from,
and connecting with friends.

## Requirements

### Requirement: Ignore list
Members SHALL ignore other members, except staff members marked as unignorable. Ignored members' posts SHALL be collapsed with a "show anyway" option, and their signatures hidden.

#### Scenario: Collapsed post
- **WHEN** a member views a topic containing posts by someone they ignore
- **THEN** those posts are collapsed with the text "You are ignoring this member" and a reveal control

#### Scenario: Ignore staff
- **WHEN** a member tries to ignore an administrator
- **THEN** the request is rejected

### Requirement: Ignore blocks contact
An ignored member SHALL NOT be able to start a private conversation with, or add to a conversation, the member ignoring them. Their mentions, quotes and replies SHALL NOT notify that member.

#### Scenario: Blocked PM
- **WHEN** an ignored member tries to start a conversation with the member ignoring them
- **THEN** the attempt is rejected with a generic "cannot message this member" error

#### Scenario: No mention notification
- **WHEN** an ignored member mentions the member ignoring them
- **THEN** no notification is delivered

### Requirement: Ignore is private and personal
Whether a member ignores someone SHALL NOT be revealed to the ignored member, and SHALL be applied via the personal overlay, not in shared cached output.

#### Scenario: Not revealed
- **WHEN** an ignored member views the profile of the member ignoring them
- **THEN** nothing indicates they are ignored

### Requirement: Friends
Members SHALL send friend requests, accept or decline them, and remove friends. Friends SHALL be listed on profiles unless the member hides the list.

#### Scenario: Accept request
- **WHEN** a member accepts a friend request
- **THEN** both members appear in each other's friend list, and the requester is notified
