# moderator-assignments Specification

## Purpose
Lets admins delegate moderation of specific forums to members or groups with precisely
chosen powers, alongside board-wide super moderators.

## Requirements

### Requirement: Forum moderator assignments
Admins SHALL assign a member or a group as moderator of a forum with any subset of powers: edit, soft-delete, hard-delete, restore, move, merge, split, pin, lock, approve, see unapproved, see deleted, view IPs, warn, view edit history and use multi-moderation.

#### Scenario: Limited moderator
- **WHEN** a member is a moderator of "Support" with only pin and lock
- **THEN** they can pin and lock topics in Support, but cannot delete posts there

### Requirement: Sub-forum scope
An assignment SHALL apply to the forum's sub-forums unless it is marked "this forum only".

#### Scenario: This forum only
- **WHEN** an assignment on "Support" is marked "this forum only"
- **THEN** the moderator has no powers in "Support › Billing"

### Requirement: Global moderator powers
Group settings SHALL be able to grant any moderator power on all forums the member can read.

#### Scenario: Super moderator
- **WHEN** the Super Moderators group grants all powers globally
- **THEN** its members can moderate in every forum they can read, and nowhere else

### Requirement: Moderator listing
Each forum SHALL be able to show its moderators (members and groups) on the forum page, configurable per forum.

#### Scenario: Show moderators
- **WHEN** a forum has "show moderators" enabled
- **THEN** its page lists the assigned moderators by display name or group name

### Requirement: Assignment changes are audited
Creating, changing or removing a moderator assignment SHALL be recorded in the admin log and SHALL take effect within 1 second.

#### Scenario: Remove moderator
- **WHEN** an admin removes a member's moderator assignment
- **THEN** within 1 second their moderation controls disappear, and mod actions return 403
