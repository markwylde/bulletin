# Spec Delta

## Purpose

Automatically keeps unwanted words and spam out of the board before it is published.

## ADDED Requirements

### Requirement: Bad-word filter
Admins SHALL define filtered words or patterns, each either replaced (with chosen text) or blocking (the save is rejected). Matching SHALL be case-insensitive and whole-word unless configured otherwise. It SHALL apply to posts, titles, signatures, profile fields, custom titles, display names and conversations.

#### Scenario: Replace
- **WHEN** a member posts a word configured to be replaced with "****"
- **THEN** the published post shows "****" instead, and the author's edit form still shows their original text

### Requirement: Replacements apply to existing content
Replacement SHALL happen when content is displayed, not by changing what the author wrote. Adding or changing a replace word SHALL apply to all existing content.

#### Scenario: New word added later
- **WHEN** an admin adds a replace word that already appears in old posts
- **THEN** those posts show the replacement on their next view, and the stored source text is unchanged

#### Scenario: Block
- **WHEN** a member submits a blocked word in a topic title
- **THEN** the save is rejected with a message that the content contains disallowed words

### Requirement: Link limits for new members
Admins SHALL set the maximum number of links (and whether images are allowed) in posts by members below a post-count or age threshold. Exceeding the limit SHALL reject the post, or hold it for approval, as configured.

#### Scenario: Too many links
- **WHEN** a member with 2 posts submits a post with 5 links, and the limit for new members is 1
- **THEN** the post is held for approval, as configured

### Requirement: Anti-spam rules
Admins SHALL enable rules that flag likely spam (repeated identical posts across topics, posting faster than a threshold, links to blocklisted domains). Flagged content SHALL be held for approval and labelled with the rule that flagged it.

#### Scenario: Duplicate posts
- **WHEN** a new member posts identical text in 3 topics within 5 minutes
- **THEN** the second and third posts are held, labelled "duplicate content"

### Requirement: Filter exemptions
Groups SHALL be exemptible from link limits and anti-spam rules. The bad-word filter SHALL apply to everyone unless a group is explicitly exempted.

#### Scenario: Staff exempt
- **WHEN** a moderator posts 5 links
- **THEN** no link limit applies
