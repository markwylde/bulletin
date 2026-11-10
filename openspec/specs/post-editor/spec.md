# post-editor Specification

## Purpose
Gives members a friendly WYSIWYG editor that stores clean markdown, works well on phones,
and never loses what they wrote.

## Requirements

### Requirement: WYSIWYG with source toggle
The editor SHALL offer a WYSIWYG mode and a markdown source mode. Switching between them SHALL NOT change the content.

#### Scenario: Round trip
- **WHEN** a member writes in WYSIWYG, switches to source and back, and saves
- **THEN** the stored markdown equals the markdown shown in source mode

### Requirement: Lossless markdown
Opening and saving content in the editor without edits SHALL produce identical markdown, including syntax the editor does not support, which SHALL be preserved as raw blocks.

#### Scenario: Unknown syntax preserved
- **WHEN** a post contains syntax from a disabled plugin and is edited elsewhere
- **THEN** the unknown syntax is unchanged after saving

### Requirement: Mobile editing
At 360 px width the editor SHALL keep its toolbar visible above the on-screen keyboard. Formatting, emoticons, mentions, quotes and image upload SHALL be reachable without horizontal scrolling.

#### Scenario: Phone toolbar
- **WHEN** a member focuses the editor on a phone
- **THEN** the toolbar stays visible above the keyboard

### Requirement: Mention autocomplete
Typing `@` followed by at least two characters SHALL suggest matching members by display name.

#### Scenario: Suggest members
- **WHEN** a member types `@jo`
- **THEN** up to 8 members whose names start with "jo" are suggested

### Requirement: Server-side draft autosave
Unsaved editor content SHALL be saved to the server automatically per member and context (new topic in a forum, reply to a topic, edit of a post, conversation). It SHALL be restored when the member returns to that context on any device.

#### Scenario: Restore draft
- **WHEN** a member types a reply, closes the tab, and later opens the same topic on another device
- **THEN** the editor offers the saved draft

#### Scenario: Draft cleared
- **WHEN** the member submits the reply
- **THEN** the draft for that context is deleted

### Requirement: Accessible editor
The editor SHALL be operable by keyboard alone, expose toolbar buttons with translated accessible names, and announce mode changes to screen readers.

#### Scenario: Keyboard formatting
- **WHEN** a member presses Ctrl/Cmd+B in WYSIWYG mode
- **THEN** the selection becomes bold
