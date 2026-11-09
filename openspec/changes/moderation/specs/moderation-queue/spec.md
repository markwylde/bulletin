# Spec Delta

## Purpose

Lets the board hold selected content for moderator approval before it becomes public, mainly
to stop spam from new accounts.

## ADDED Requirements

### Requirement: Configurable new-member approval
Admins SHALL be able to enable approval of a new member's first N approved posts and topics, with N configurable. The setting SHALL be off by default.

#### Scenario: First posts held
- **WHEN** approval is on with N = 3 and a new member posts
- **THEN** the post is held as unapproved until a moderator approves it

#### Scenario: Threshold reached
- **WHEN** the member has 3 approved posts
- **THEN** their next post is published immediately

### Requirement: Other approval sources
Content SHALL also be held when any of the author's groups sets "posts require approval", when the forum requires approval for new topics or posts, when a warning action puts the member on moderation, or when a content filter flags it.

#### Scenario: Forum requires approval
- **WHEN** a forum requires approval of new topics
- **THEN** every new topic there is held, including from regular members

### Requirement: Held content visibility
Held content SHALL be visible only to its author (marked as awaiting approval) and to moderators with see-unapproved for that forum. It SHALL not count in public counters or appear in public lists, searches or feeds.

#### Scenario: Author sees own
- **WHEN** an author views a topic containing their held reply
- **THEN** they see it marked "Awaiting approval", and other members do not see it

#### Scenario: Two authors, one cached page
- **WHEN** two regular members each have a held reply in the same topic and view its last page one after the other
- **THEN** each sees only their own held reply, and the shared cached page contains neither

### Requirement: Approval queue
Moderators SHALL see a queue of held content in forums they can approve in, with author, reason held and content preview. They SHALL approve or reject (delete) items singly or in bulk.

#### Scenario: Bulk approve
- **WHEN** a moderator approves 10 queued posts at once
- **THEN** all 10 become public, counters update, and their authors are notified

### Requirement: Queue counts
Moderators SHALL see a live count of items awaiting their approval.

#### Scenario: Count updates
- **WHEN** a new item is held in a forum a moderator approves in
- **THEN** their queue count increases within 5 seconds
