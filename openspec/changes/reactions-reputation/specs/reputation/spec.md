# Spec Delta

## Purpose

Gives each member a reputation score reflecting how others value their posts, with limits
that discourage abuse.

## ADDED Requirements

### Requirement: Reputation sources
A member's reputation SHALL be the sum of reputation points from feedback on their posts: explicit +1/−1 reputation votes, plus the weights of reactions to their posts when the board setting "reactions affect reputation" is on.

#### Scenario: Reaction weight
- **WHEN** reactions affect reputation and a member's post receives a "Like" with weight +1
- **THEN** their reputation increases by 1

### Requirement: Giving limits
Giving reputation SHALL require the group permission, a minimum post count, and a remaining daily allowance. Negative reputation SHALL be separately permitted per group. Members SHALL NOT give reputation to their own posts or more than once per post.

#### Scenario: Daily limit
- **WHEN** a member with a daily limit of 10 tries to give an 11th reputation point today
- **THEN** it is rejected, with the time the allowance resets

#### Scenario: Negative not allowed
- **WHEN** a member whose groups do not allow negative reputation gives −1
- **THEN** it is rejected

### Requirement: Receiving permission
Groups SHALL be able to opt out of receiving reputation. Feedback on such members' posts SHALL have no reputation effect.

#### Scenario: Staff exempt
- **WHEN** the Administrators group cannot receive reputation and an admin's post gets +1
- **THEN** the admin's reputation is unchanged

### Requirement: Reputation display
Reputation totals SHALL be shown on profiles and next to posts, with a configurable label scale (for example "Respected" at 100 or more). Display SHALL be switchable off board-wide.

#### Scenario: Label
- **WHEN** a member has 120 reputation and the scale labels ≥ 100 as "Respected"
- **THEN** their posts show "Respected"

### Requirement: Staff controls
Staff with `members.reputation` SHALL remove individual reputation entries and trigger a recount for a member. Actions SHALL be logged.

#### Scenario: Remove abusive votes
- **WHEN** staff remove 5 negative votes from a vote-ring member
- **THEN** the target's reputation increases by 5, and the action is logged
