# Spec Delta

## Purpose

Gives moderators efficient tools to organise and clean up topics and posts, including
reusable multi-step actions.

## ADDED Requirements

### Requirement: Merge topics
Moderators with merge in both forums SHALL merge two or more topics into one, choosing the destination title. Posts SHALL be ordered by date, and the source topics SHALL be removed or left as redirect stubs.

#### Scenario: Merge
- **WHEN** a moderator merges topic B into topic A
- **THEN** A contains all posts from both in date order, and B redirects to A

### Requirement: Split topics
Moderators with split SHALL move selected posts from a topic into a new topic (in any forum they can moderate) or into an existing topic.

#### Scenario: Split to new topic
- **WHEN** a moderator selects 4 off-topic posts and splits them into a new topic
- **THEN** a new topic with those posts exists, and the original no longer contains them

### Requirement: Move and copy topics
Moderators with move SHALL move topics between forums they moderate, optionally leaving a redirect stub for a chosen number of days. They SHALL also be able to copy topics.

#### Scenario: Move without stub
- **WHEN** a moderator moves a topic without a stub
- **THEN** it appears only in the destination, and counts of both forums update

### Requirement: Bulk actions
Moderators SHALL select multiple topics in a forum list, or multiple posts in a topic, and apply an action (pin, unpin, lock, unlock, move, soft-delete, restore, approve) to all of them.

#### Scenario: Bulk lock
- **WHEN** a moderator selects 5 topics and chooses Lock
- **THEN** all 5 topics are locked

### Requirement: Multi-moderation
Admins SHALL define multi-moderation actions: a named set of steps (move to forum, lock/unlock, pin/unpin, set prefix, prepend/append to title, add a reply as a chosen member) available in chosen forums. Moderators with the multi-mod power SHALL apply them in one click.

#### Scenario: Mark solved
- **WHEN** a moderator applies "Mark solved" (set prefix Solved, lock, add reply "Marked as solved")
- **THEN** all three steps happen, and one log entry records the multi-mod action

### Requirement: Moderator controls only for permitted actions
Moderation controls SHALL be shown only for actions the viewer may perform on that forum, and the API SHALL reject any other action.

#### Scenario: Missing power
- **WHEN** a moderator without split calls the split endpoint
- **THEN** the API responds 403
