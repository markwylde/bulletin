# forum-permissions Specification

## Purpose
Controls exactly who can see and act in each forum through reusable permission masks, with
deterministic semantics that every feature and cache relies on.

## Requirements

### Requirement: Permission masks
Admins SHALL create named permission masks and link each group to one or more masks. A member's masks SHALL be the union of their groups' masks.

#### Scenario: Shared mask
- **WHEN** groups Members and Regulars both link mask "Standard"
- **THEN** changing "Standard" changes both groups' forum access

### Requirement: Forum action matrix
Each forum SHALL define, per mask, the actions `show`, `read`, `start`, `reply`, `upload`, `download` and `vote`, plus registered plugin actions. `read` SHALL imply `show`. A member may perform an action if any of their masks allows it.

#### Scenario: Show without read
- **WHEN** a member's masks allow `show` but not `read` on a forum
- **THEN** the forum appears in lists with name and description, but opening it is denied and no topic titles are revealed

### Requirement: Ancestor rule
An action on a forum SHALL be allowed only if the member also has `show` on every ancestor forum and category.

#### Scenario: Hidden parent
- **WHEN** a member can `read` a sub-forum but cannot `show` its parent
- **THEN** the sub-forum is invisible and inaccessible to them

### Requirement: Matrix inheritance
A forum SHALL inherit its parent's matrix unless it is set to override. Changing the parent SHALL change all inheriting descendants.

#### Scenario: Inherited change
- **WHEN** an admin removes `reply` for mask "Standard" on a category whose forums inherit
- **THEN** members relying on "Standard" can no longer reply in those forums

### Requirement: Matrix editor
Staff with `acp.permissions` SHALL edit a forums × masks grid per action, with row and column bulk toggles, and SHALL see which forums inherit.

#### Scenario: Bulk toggle
- **WHEN** an admin bulk-enables `read` for a mask across a category column
- **THEN** every non-overriding forum in that category grants `read` to the mask

### Requirement: Password-protected forums
A forum MAY have a password. Reading it SHALL then additionally require that the current session has unlocked it. Unlocks SHALL end with the session.

#### Scenario: Unlock
- **WHEN** a member with `read` enters the correct forum password
- **THEN** they can read the forum for the rest of that session only

#### Scenario: Wrong password throttled
- **WHEN** five wrong passwords are entered within 10 minutes
- **THEN** further attempts are refused for 10 minutes

### Requirement: Single authorization path
Every read or write of forum content SHALL be authorised through the permission service, for all channels: pages, search, attachments, feeds, sitemaps, previews, counters, notifications, webhooks, real-time streams and APIs.

#### Scenario: Architecture check
- **WHEN** a content query bypasses the permission-filtered data access functions
- **THEN** the architecture test fails the build

### Requirement: Changes take effect promptly
Permission, mask, group and membership changes SHALL apply to members' requests within 1 second.

#### Scenario: Revoke read
- **WHEN** an admin removes `read` on a forum from a mask
- **THEN** within 1 second members relying on that mask receive 403 for the forum's topics

### Requirement: Visibility dependencies are declared and verified
Each cacheable view SHALL declare which permission bits it depends on, and SHALL be cached per distinct combination of those bits. In development and test, reading an undeclared bit during rendering SHALL fail.

#### Scenario: Undeclared bit
- **WHEN** a view reads the `reply` bit without declaring it
- **THEN** rendering it in a test throws an error naming the view and the bit
