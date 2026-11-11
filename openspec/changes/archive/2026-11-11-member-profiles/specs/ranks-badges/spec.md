# Spec Delta

## Purpose

Recognises members' participation and achievements with post-count ranks, custom titles and
badges.

## ADDED Requirements

### Requirement: Post-count ranks
Staff with `acp.ranks` SHALL define ranks with a minimum post count, translated title and pip count or image. A member's rank SHALL be the highest rank whose minimum they meet, shown with their posts and profile.

#### Scenario: Rank up
- **WHEN** a member reaches the minimum post count of the next rank
- **THEN** their posts show the new rank title and pips

### Requirement: Custom titles
Members whose groups allow it SHALL set a custom title that replaces the rank title, subject to a maximum length and the bad-word filter.

#### Scenario: Custom title shown
- **WHEN** a VIP member sets the custom title "Night Owl"
- **THEN** "Night Owl" is shown instead of their rank title, and pips are still shown

### Requirement: Badge definitions
Staff with `acp.badges` SHALL define badges with an image, translated name and description, and either manual awarding only or an automatic rule.

#### Scenario: Create badge
- **WHEN** staff create a manual badge "Helpful"
- **THEN** it is available to award

### Requirement: Automatic badge rules
Automatic badges SHALL be awarded when a member meets a rule: post count, reputation, days since joining, reactions received, topics started, or a count of posts in a chosen forum. Rules SHALL be evaluated after relevant events and nightly. Each badge SHALL be awarded at most once per member.

#### Scenario: Auto-award
- **WHEN** a badge rule requires 1,000 posts and a member's 1,000th post is approved
- **THEN** the member receives the badge and a notification

### Requirement: Manual award and revoke
Staff with `members.badges` SHALL award or revoke any badge for a member with a reason. Awards and revocations SHALL be logged.

#### Scenario: Revoke
- **WHEN** staff revoke a badge
- **THEN** it disappears from the member's profile, and the revocation is logged

### Requirement: Badge display
Members' badges SHALL be shown on their profile. Members SHALL choose up to 3 badges to feature next to their posts.

#### Scenario: Featured badges
- **WHEN** a member features 2 badges
- **THEN** those 2 badges appear under their name on posts
