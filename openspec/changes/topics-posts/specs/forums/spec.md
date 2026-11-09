# Spec Delta

## ADDED Requirements

### Requirement: Latest readable post on the index
The board index and forum lists SHALL show, for each forum, the latest post the viewer may read.

#### Scenario: Last post respects permissions
- **WHEN** the latest post in a forum is in a topic the viewer cannot read (unapproved, and the viewer lacks see-unapproved)
- **THEN** the index shows the latest post the viewer can read instead

### Requirement: Prefixes on topics
Topics SHALL carry an optional prefix from those enabled in their forum, and forums that require a prefix SHALL reject topics without one. Topic lists SHALL filter by prefix.

#### Scenario: Required prefix
- **WHEN** a forum requires a prefix and a member starts a topic without one
- **THEN** the topic is rejected with an error asking for a prefix

#### Scenario: Filter by prefix
- **WHEN** a viewer clicks a prefix on a topic list
- **THEN** the list shows only topics with that prefix

### Requirement: Forum deletion with topics
Deleting a forum that contains topics SHALL require choosing whether they move to another forum or are deleted.

#### Scenario: Delete with move
- **WHEN** an admin deletes a forum and chooses to move topics to "Archive"
- **THEN** all its topics appear in "Archive"
