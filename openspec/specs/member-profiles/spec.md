# member-profiles Specification

## Purpose
Gives every member a profile showing who they are and how they participate, with
staff-defined fields and member-controlled privacy.

## Requirements

### Requirement: Profile page
Each member SHALL have a profile showing display name, avatar, group title, rank, badges, joined date, post count, reputation, last active (unless hidden), visible custom fields, an about section, and recent posts the viewer can read.

#### Scenario: Recent posts respect permissions
- **WHEN** a guest views a member's profile and the member's latest posts are in a staff-only forum
- **THEN** those posts are not listed

### Requirement: Custom profile fields
Staff with `acp.profile_fields` SHALL define fields (short text, long text, number, date, URL, single select, multi select) with translated labels, required/optional, and per-group settings for who can view and who can edit each field.

#### Scenario: Staff-only field
- **WHEN** a field is visible only to Moderators
- **THEN** members viewing the profile do not see it, and moderators do

#### Scenario: Required field
- **WHEN** a required field is added and a member edits their profile
- **THEN** they cannot save without filling it

### Requirement: Field visibility in cached output
Profile output SHALL be cached per viewer field-visibility class, so a viewer never receives a field their groups cannot view.

#### Scenario: Variant per class
- **WHEN** a moderator and a member view the same profile
- **THEN** they receive different cached variants, and the member's contains no staff-only field

### Requirement: Signatures
Members whose groups allow it SHALL set a signature, limited by the group's maximum length, lines, images and links. Signatures SHALL render under posts using the signature profile. Members SHALL be able to hide all signatures for themselves.

#### Scenario: Too many links
- **WHEN** a member whose groups allow 2 links saves a signature with 3 links
- **THEN** the save is rejected, naming the limit

#### Scenario: Hide signatures
- **WHEN** a member turns on "hide signatures"
- **THEN** no signatures are shown to them under posts

### Requirement: Privacy options
Members SHALL be able to hide their online status and exclude themselves from the member list. Staff with `members.view_hidden` SHALL still see them.

#### Scenario: Hidden online
- **WHEN** a member hides their online status
- **THEN** they do not appear in who's online for regular members, and their profile shows no last-active time

### Requirement: Profile editing
Members SHALL edit their about section, custom fields they may edit, signature and privacy options. Staff with `members.edit` SHALL edit any member's profile, and the change SHALL be logged.

#### Scenario: Staff edit logged
- **WHEN** a moderator edits a member's about text
- **THEN** the change is saved and recorded in the admin log (the moderation log adds it from `moderation`)
