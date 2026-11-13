# plugin-admin-forms Specification

## Purpose
Lets plugins add configuration and admin screens that look and behave exactly like the rest
of the staff app, without shipping any staff-app code.

## Requirements

### Requirement: Declarative plugin settings
Plugins SHALL declare settings forms using the staff app's form definition format. The staff app SHALL render them with core components, validate input against the declaration, and save values in the plugin's namespace.

#### Scenario: Invalid value
- **WHEN** an admin enters a value that violates a plugin setting's declared validation
- **THEN** the form shows the translated error and does not save

### Requirement: Extension points on core settings
Plugins SHALL add sections to declared extension points on core settings pages (such as group settings and forum settings), using the same form format. Core fields SHALL NOT be removed or altered by plugins.

#### Scenario: Group settings section
- **WHEN** a plugin adds a section to group settings
- **THEN** it appears below the core sections, and the core fields are unchanged

### Requirement: Fixed admin page types
Plugins SHALL add admin pages only as a settings form, a data table (declared columns and row actions calling plugin routes), or a log viewer. Plugins SHALL NOT supply custom staff-app code.

#### Scenario: Data table page
- **WHEN** a plugin declares a data table page
- **THEN** it appears in the staff navigation under Plugins, rendered with the core table component, including the mobile card view

### Requirement: Plugin manager screen
The staff app SHALL show each installed plugin's state, version, granted capabilities, elevated grants, hook timings, error log and breaker status, with actions to configure, upgrade, disable and uninstall.

#### Scenario: Error log
- **WHEN** a plugin hook has failed recently
- **THEN** the plugin manager shows the failures with time, hook and error message
