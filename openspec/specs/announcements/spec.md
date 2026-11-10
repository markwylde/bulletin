# announcements Specification

## Purpose
Lets staff publish important notices board-wide or in specific forums for a set period and
audience.

## Requirements

### Requirement: Announcements
Staff with `acp.announcements` SHALL create announcements with a title, markdown body, start and optional end date, scope (global or chosen forums, optionally including sub-forums), and an optional list of target groups.

#### Scenario: Forum announcement
- **WHEN** an announcement targets the "Support" forum
- **THEN** it appears above the topic list in Support and nowhere else

#### Scenario: Group-targeted
- **WHEN** an announcement targets only the Members group
- **THEN** guests do not see it

#### Scenario: Targeted announcement in a shared cache
- **WHEN** a VIP-targeted announcement is shown to a VIP member and a regular member with identical forum permissions then views the same forum page
- **THEN** the regular member does not see the announcement

### Requirement: Scheduling
Announcements SHALL appear only between their start and end dates, without manual action.

#### Scenario: Expiry
- **WHEN** an announcement's end date passes while pages showing it are cached
- **THEN** within one minute it no longer appears on any page, without any staff action

### Requirement: Dismissal
Members SHALL be able to dismiss a dismissible announcement. It SHALL stay dismissed for them until its content is updated.

#### Scenario: Updated after dismissal
- **WHEN** a member dismissed an announcement and staff then edit its body
- **THEN** it reappears for that member
