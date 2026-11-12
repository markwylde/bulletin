# Spec Delta

## Purpose

Keeps an accountable record of every moderation action, so staff can review what happened
and who did it.

## ADDED Requirements

### Requirement: Every moderator action logged
Every moderation action (approve, delete, restore, edit others' content, move, merge, split, pin, lock, multi-mod, warn, revoke warning, ban, unban, IP lookup, report status changes, PM report views) SHALL be logged with actor, action, target, forum, details and time.

#### Scenario: Merge logged
- **WHEN** a moderator merges two topics
- **THEN** the log shows the moderator, "topic.merge", both topic IDs and the destination

### Requirement: Log access
Admins SHALL view and filter the full log by moderator, action, forum, member affected and date. Forum moderators SHALL view entries for the forums they moderate.

#### Scenario: Forum moderator scope
- **WHEN** a forum moderator opens the log
- **THEN** they see only entries for their forums

### Requirement: Log integrity
Log entries SHALL NOT be editable or deletable through the application, except by the retention policy.

#### Scenario: No delete
- **WHEN** an admin looks for a way to delete a log entry
- **THEN** no such action exists in the staff app or API
