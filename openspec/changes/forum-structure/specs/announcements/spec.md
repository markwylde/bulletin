# Spec Delta

## Purpose

Lets staff publish important notices board-wide or in specific forums for a set period and
audience.

## ADDED Requirements

### Requirement: Announcements
Staff with `acp.announcements` SHALL create announcements with a title, markdown body, start and optional end date, scope (global or chosen forums, optionally including sub-forums), and an optional list of target groups.

#### Scenario: Forum announcement
- **WHEN** an announcement targets the "Support" forum
- **THEN** it appears above the topic list in Support and nowhere else

#### Scenario: Group-targeted
- **WHEN** an announcement targets only the Members group
- **THEN** guests do not see it

### Requirement: Scheduling
Announcements SHALL appear only between their start and end dates, without manual action.

#### Scenario: Expiry
- **WHEN** an announcement's end date passes
- **THEN** it no longer appears on any page

### Requirement: Dismissal
Members SHALL be able to dismiss a dismissible announcement. It SHALL stay dismissed for them until its content is updated.

#### Scenario: Updated after dismissal
- **WHEN** a member dismissed an announcement and staff then edit its body
- **THEN** it reappears for that member
