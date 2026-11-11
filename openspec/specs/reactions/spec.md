# reactions Specification

## Purpose
Lets members respond to posts with a quick, expressive reaction instead of a reply.

## Requirements

### Requirement: Reaction set
Staff with `acp.reactions` SHALL define reactions with an icon, a translated label, an order, an enabled flag and a reputation weight (−1, 0 or +1).

#### Scenario: Disable a reaction
- **WHEN** staff disable the "Confused" reaction
- **THEN** members can no longer choose it, and existing ones remain visible

### Requirement: React to posts
Members whose groups allow reacting SHALL add one reaction per post they can read, change it, or remove it. Members SHALL NOT react to their own posts.

#### Scenario: Change reaction
- **WHEN** a member who reacted "Like" picks "Thanks" on the same post
- **THEN** the post shows one "Thanks" from them and no "Like"

#### Scenario: Own post
- **WHEN** a member tries to react to their own post
- **THEN** the request is rejected

### Requirement: Reaction display
Each post SHALL show reaction totals by type. Viewers SHALL open a list of who reacted with each type. The viewer's own reaction SHALL be indicated via the personal overlay.

#### Scenario: Who reacted
- **WHEN** a viewer clicks a reaction total
- **THEN** a list of members who gave that reaction is shown

### Requirement: Reaction notifications
The post author SHALL be notified of reactions according to their notification preferences, coalesced per post.

#### Scenario: Coalesced
- **WHEN** three members react to the same post
- **THEN** the author has one notification saying three people reacted
