# Spec Delta

## Purpose

Lets admins change every aspect of how the user app looks, safely, at runtime, and lets
members pick the look they prefer from what their groups allow.

## ADDED Requirements

### Requirement: Default theme
The board SHALL ship with a default theme covering every user-app page, with light and dark variants. It SHALL work at 360 px width and meet WCAG AA contrast in both variants.

#### Scenario: Dark variant
- **WHEN** a member chooses dark mode with the default theme
- **THEN** every page renders with the dark variant and passes the contrast check

### Requirement: Child themes
Admins SHALL create a child theme of any theme. A child theme SHALL inherit every template, token, asset and string it does not override.

#### Scenario: Parent update flows through
- **WHEN** the parent theme's footer template changes and the child does not override the footer
- **THEN** the child theme shows the new footer

### Requirement: Template editor
Staff with `acp.themes` SHALL edit any template of a theme in a code editor showing the parent version, a diff against it, validation errors, and a revert-to-parent action. Every save SHALL create a version that can be restored.

#### Scenario: Restore version
- **WHEN** an admin restores a template to a version from yesterday
- **THEN** pages render with that version

### Requirement: Tokens and CSS
Admins SHALL edit a theme's design tokens (colours, fonts, spacing, radii) for light and dark through a form, and add custom CSS. External resources in CSS SHALL be limited to the theme's own assets.

#### Scenario: External import blocked
- **WHEN** custom CSS contains `@import url(https://evil.example/x.css)`
- **THEN** the save is rejected

### Requirement: Preview before activation
Admins SHALL preview any theme on any page as themselves without affecting other viewers.

#### Scenario: Preview
- **WHEN** an admin previews an inactive theme from the staff app
- **THEN** only their user-app session renders with it, and those responses are never stored in a shared cache

#### Scenario: Guest cookie names a restricted theme
- **WHEN** a guest sets the `bp` cookie to a theme available only to VIPs
- **THEN** the page renders with the default theme

### Requirement: Install and export
Admins SHALL install themes from the marketplace or by uploading a signed theme bundle, and export any theme as a bundle. Installation SHALL run every template, CSS and island check and SHALL refuse a theme that fails any of them.

#### Scenario: Unsigned bundle
- **WHEN** an admin uploads a theme bundle with an invalid signature
- **THEN** installation is refused

#### Scenario: Failing check
- **WHEN** a marketplace theme's topic template omits the required reply editor
- **THEN** installation is refused, naming the template and island

### Requirement: Theme availability by group
Each theme SHALL have a list of groups allowed to use it, and each group SHALL have a default theme. A member SHALL be offered only themes allowed for any of their groups.

#### Scenario: VIP theme
- **WHEN** the "Gold" theme is allowed only for VIP
- **THEN** VIP members can choose it, and other members do not see it in the chooser

#### Scenario: Lost access
- **WHEN** a member's chosen theme stops being allowed for their groups
- **THEN** they see their primary group's default theme

### Requirement: Member theme choice
Members SHALL choose a theme and a colour scheme (light, dark or system) from the footer and from their settings. Guests SHALL choose among themes allowed for Guests, remembered in the preference cookie.

#### Scenario: Guest choice
- **WHEN** a guest picks dark mode
- **THEN** the preference cookie records it, and pages render dark
