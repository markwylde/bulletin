# groups Specification

## Purpose
Organises members into groups that determine their abilities, limits and appearance, in the
style of classic Invision Power Board group settings.

## Requirements

### Requirement: Primary and secondary groups
Every member SHALL have exactly one primary group and zero or more secondary groups. Display attributes (name colour, group title, icon) SHALL come from the primary group only.

#### Scenario: Display from primary
- **WHEN** a member's primary group is Members (no colour) and a secondary group is VIP (gold)
- **THEN** their name is shown without the VIP colour

### Requirement: Built-in groups
The board SHALL have built-in Guests, Members, Banned and Administrators groups that cannot be deleted. Admins SHALL be able to create, rename, reorder and delete other groups.

#### Scenario: Delete custom group
- **WHEN** an admin deletes a custom group that has members as their primary group
- **THEN** they must choose a replacement primary group, and those members are moved to it

### Requirement: Typed group settings with merge rules
Group settings SHALL be defined in a registry where each setting has a type, a default and a merge rule (`allow-any`, `restrict-any`, `max`, `min`, or `primary`). A member's effective settings SHALL be computed by applying each rule across all their groups.

#### Scenario: Upload quota uses max
- **WHEN** a member's groups grant upload quotas of 10 MB and 50 MB
- **THEN** their effective quota is 50 MB

#### Scenario: Restriction wins
- **WHEN** one of a member's groups sets `posts_require_approval` and another does not
- **THEN** the member's posts require approval

#### Scenario: Flood control uses min
- **WHEN** a member's groups set flood control to 30 s and 5 s
- **THEN** their effective flood control is 5 s

### Requirement: Group settings matrix screen
Staff with `acp.groups` SHALL edit group settings in sections. A matrix view SHALL compare any setting across all groups side by side.

#### Scenario: Compare across groups
- **WHEN** an admin opens the matrix for "edit window"
- **THEN** every group's value is shown in one table, and any cell can be edited

### Requirement: Membership management
Staff with `acp.members.groups` SHALL set a member's primary and secondary groups. Each change SHALL be logged and SHALL take effect on the member's next request.

#### Scenario: Add secondary group
- **WHEN** a staff member adds VIP as a secondary group of a member
- **THEN** the member's next request reflects VIP's permissions, and their session is rotated

### Requirement: Auto-promotion rules
Admins SHALL define ordered promotion rules that move a member from one group to another when registered criteria meet thresholds. This change SHALL provide the days-since-joining criterion; later changes register approved post count and reputation. Rules SHALL be evaluated when a criterion's value changes and nightly, and each promotion SHALL emit `member.promoted`.

#### Scenario: Promotion on days since joining
- **WHEN** a rule promotes Members to Regulars at 30 days since joining, and the nightly run finds a member who joined 30 days ago
- **THEN** their primary group becomes Regulars and a `member.promoted` event is recorded

#### Scenario: Concurrent evaluation
- **WHEN** two evaluations for the same member run at once
- **THEN** the promotion is applied once
