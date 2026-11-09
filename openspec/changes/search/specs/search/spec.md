# Spec Delta

## Purpose

Lets people find discussions, posts and members quickly. Results only ever include content
they are currently allowed to read.

## ADDED Requirements

### Requirement: Full-text search
Viewers SHALL search topics and posts by words, with support for quoted phrases, `-exclusion` and `OR`. Matching SHALL use the content's language (English, Spanish or French) and also match unstemmed words.

#### Scenario: Stemming
- **WHEN** a viewer searches "running" in English content
- **THEN** posts containing "run" or "runs" match

#### Scenario: Phrase and exclusion
- **WHEN** a viewer searches `"power supply" -laptop`
- **THEN** results contain the phrase "power supply" and not the word "laptop"

### Requirement: Immediate indexing
New and edited content SHALL be searchable as soon as it is saved.

#### Scenario: Just posted
- **WHEN** a member posts a reply and searches a unique word from it
- **THEN** the reply is in the results

### Requirement: Results limited to readable content
Results SHALL include only content the viewer can currently read, in its current state. Unapproved and soft-deleted content SHALL appear only for viewers with the matching moderator powers. Quoted text SHALL NOT match the quoting post.

#### Scenario: Hidden forum
- **WHEN** a guest searches a word that appears only in a staff-only forum
- **THEN** there are no results

#### Scenario: Deleted after indexing
- **WHEN** a post is soft-deleted
- **THEN** it stops appearing in members' results immediately

### Requirement: Filters and sorting
Search SHALL filter by forums (including sub-forums), author, date range, prefix, and topics-only versus posts, and SHALL sort by relevance or date.

#### Scenario: Forum filter
- **WHEN** a viewer searches within "Support"
- **THEN** only results from Support and its sub-forums are shown

### Requirement: Safe snippets
Results SHALL show a short plain-text snippet with matches highlighted. Snippets SHALL never render content as HTML.

#### Scenario: Markup in snippet
- **WHEN** matching content contains `<b>` as text
- **THEN** the snippet shows `<b>` literally, and only the highlight markup is real HTML

### Requirement: Member search
The member search SHALL match display names approximately, ranking prefix and close matches first, and SHALL respect member-list opt-outs.

#### Scenario: Typo
- **WHEN** a viewer searches "jhon"
- **THEN** a member named "John" is among the top results

### Requirement: Search flood control
Searches SHALL be limited by the viewer's group search interval.

#### Scenario: Too frequent
- **WHEN** a guest with a 10-second search interval searches twice within 3 seconds
- **THEN** the second search is refused, with the wait time

### Requirement: Activity views
Members SHALL view "all content by member X" and "new content since my last visit", both limited to readable content and paginated.

#### Scenario: Since last visit
- **WHEN** a member opens "new content"
- **THEN** they see topics with readable posts newer than their previous visit (`previous_visit_at`, rolled over after 30 minutes of inactivity)
