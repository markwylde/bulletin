# Spec Delta

## Purpose

Defines how the board is organised into categories, forums and sub-forums, and the settings
each forum carries.

## ADDED Requirements

### Requirement: Forum tree
The board SHALL be organised as categories containing forums, and forums SHALL contain sub-forums to any depth. Admins SHALL reorder and move any node. Moving a forum under its own descendant SHALL be rejected.

#### Scenario: Deep nesting
- **WHEN** an admin creates a sub-forum five levels deep
- **THEN** it appears under its parent, with breadcrumbs showing every ancestor

#### Scenario: Cycle rejected
- **WHEN** an admin moves a forum under one of its own sub-forums
- **THEN** the move is rejected with an error

### Requirement: Board index
The board index SHALL list the categories and forums the viewer may `show`, each with description, sub-forum links, topic and post counts, and the latest post the viewer may `read`.

#### Scenario: Last post respects permissions
- **WHEN** the latest post in a forum is in a topic the viewer cannot read (unapproved, and the viewer lacks see-unapproved)
- **THEN** the index shows the latest post the viewer can read instead

### Requirement: Redirect forums
A redirect forum SHALL link to a URL instead of containing topics. Clicks SHALL be counted and displayed. Redirect forums SHALL respect `show` permission.

#### Scenario: Follow redirect
- **WHEN** a member clicks a redirect forum
- **THEN** they are sent to its URL, and the click count increases by one

### Requirement: Forum rules box
A forum MAY have rules text in markdown, shown above its topic list. It SHALL be collapsible, and its collapsed state SHALL be remembered per viewer.

#### Scenario: Rules shown
- **WHEN** a member opens a forum with rules
- **THEN** the rules appear above the topic list

### Requirement: Topic prefixes
Admins SHALL define topic prefixes (label and colour, translatable) and enable a set per forum, marking prefixes as required or optional. Prefixes MAY be restricted to groups.

#### Scenario: Required prefix
- **WHEN** a forum requires a prefix and a member starts a topic without one
- **THEN** the topic is rejected with an error asking for a prefix

#### Scenario: Filter by prefix
- **WHEN** a viewer clicks a prefix on a topic list
- **THEN** the list shows only topics with that prefix

### Requirement: Slugged URLs
Categories and forums SHALL have URLs of the form `/forum/<id>-<slug>`, resolved by numeric ID only. Requests with a missing or outdated slug SHALL permanently redirect to the current one.

#### Scenario: Renamed forum
- **WHEN** a forum is renamed and an old URL is requested
- **THEN** the response is a 301 to the URL with the new slug

### Requirement: Forum deletion
Deleting a forum SHALL require choosing whether its topics move to another forum or are deleted. Sub-forums SHALL move to the deleted forum's parent.

#### Scenario: Delete with move
- **WHEN** an admin deletes a forum and chooses to move topics to "Archive"
- **THEN** all its topics appear in "Archive", and its sub-forums move up one level
