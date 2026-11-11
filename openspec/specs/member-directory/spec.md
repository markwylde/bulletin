# member-directory Specification

## Purpose
Shows the community to itself: who is here, who is online, how the board is doing, and who
contributes most.

## Requirements

### Requirement: Member list
Viewers with `members.view_list` SHALL browse members with search by name, filters (group, joined date range) and sorting (name, joined, posts, reputation), paginated. Members who opted out SHALL be excluded.

#### Scenario: Filter by group
- **WHEN** a viewer filters the member list by the Moderators group
- **THEN** only members whose primary or secondary groups include Moderators are listed

### Requirement: Who's online
The board index SHALL show the number of members and guests active in the last 15 minutes, and the names of visible members, styled by primary group. A full online list SHALL show each visible member's current location if the viewer can read it.

#### Scenario: Location hidden
- **WHEN** a member is viewing a staff-only forum
- **THEN** a regular member's online list shows them as "Viewing the board" instead of the forum name

### Requirement: Board statistics
The board index SHALL show total topics, posts and members, the newest member, and the record online count with its date.

#### Scenario: New record
- **WHEN** more users are online than the stored record
- **THEN** the record and date update

### Requirement: Leaderboards
A leaderboards page SHALL show top posters and most-reacted members for this week, this month and all time, counting only content visible to guests.

#### Scenario: Private content excluded
- **WHEN** a member's posts are all in a staff-only forum
- **THEN** they do not rank on leaderboards from those posts

### Requirement: Today's top poster
The board index SHALL be able to show today's top poster, configurable by admins.

#### Scenario: Today's top poster
- **WHEN** enabled and a member has made the most visible posts today
- **THEN** the index shows them as today's top poster
