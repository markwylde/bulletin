# staff-console Specification

## Purpose
Gives administrators and moderators a single, consistent, mobile-friendly control panel to
run the board, with every staff action gated by permissions and recorded.

## Requirements

### Requirement: Staff app access is a Bulletin permission
Only members whose groups grant `acp.access` SHALL be able to use the staff app. Each ACP section SHALL additionally require its own permission.

#### Scenario: Regular member denied
- **WHEN** a member without `acp.access` logs in to the staff app
- **THEN** they see an access-denied page, and every staff API call returns 403

#### Scenario: Moderator sees limited sections
- **WHEN** a super moderator with `acp.access` but without `acp.settings` opens the staff app
- **THEN** the navigation hides Board Settings, and requests to its API return 403

### Requirement: Light, dark and system modes
The staff app SHALL offer light, dark and system colour modes. The choice SHALL be remembered per staff member. The staff app SHALL NOT be themeable.

#### Scenario: Dark mode persists
- **WHEN** a staff member selects dark mode and logs in on another device
- **THEN** the staff app renders in dark mode

### Requirement: Mobile-usable control panel
Every staff screen SHALL be fully usable at 360 px width: navigation collapses to a menu, tables become cards, and forms stack vertically.

#### Scenario: Table on phone
- **WHEN** a list screen is opened at 360 px
- **THEN** each row renders as a card with its actions reachable, without horizontal scrolling

### Requirement: Board settings
Admins SHALL be able to edit board name, description, default locale, and board offline mode with a message. While offline, only groups with `board.view_offline` SHALL see the forum.

#### Scenario: Board offline
- **WHEN** an admin turns on offline mode
- **THEN** guests and members without `board.view_offline` see the offline message, and admins still see the forum

### Requirement: Admin action log
Every state-changing staff action SHALL be recorded with actor, action, target, a before/after summary and time. Admins SHALL be able to filter the log by actor, action and date.

#### Scenario: Setting change logged
- **WHEN** an admin changes the board name
- **THEN** the admin log shows the actor, "board.settings.update", and the old and new names

### Requirement: Declarative forms
Settings screens SHALL be rendered from declarative form definitions supporting sections, field types (text, number, toggle, select, multi-select, group picker, forum picker, duration, markdown), validation, conditional visibility, and translated labels.

#### Scenario: Validation error
- **WHEN** a staff member enters a value outside a number field's declared range
- **THEN** the form shows a translated inline error and does not submit

### Requirement: Dashboard
The staff app home SHALL be composed of registered widgets, each gated by an ACP permission. This change SHALL provide member statistics, recent admin log entries and system health; later changes register content statistics and moderation counts.

#### Scenario: Moderator dashboard
- **WHEN** a moderator without admin permissions opens the dashboard
- **THEN** the system health and admin log widgets are absent, and no request for their data succeeds
