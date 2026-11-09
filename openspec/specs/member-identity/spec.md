# member-identity Specification

## Purpose
Creates and maintains Bulletin's own member record for each DarkAuth identity, keeping
external identity data restricted. Also owns the forum display name and its history.

## Requirements

### Requirement: Member created on first login
The first successful login of a DarkAuth identity SHALL create a member with the board's default groups. The identity SHALL be mapped by `(issuer, subject)`.

#### Scenario: First login
- **WHEN** an identity logs in for the first time
- **THEN** a member is created and placed in the default Members group

#### Scenario: Returning login
- **WHEN** the same identity logs in again
- **THEN** the existing member is used and no duplicate is created

### Requirement: Identity data is restricted
Issuer, subject, email and the identity provider's name SHALL be stored only as restricted personal data. They SHALL never appear in member-facing pages, public APIs or logs.

#### Scenario: Profile page
- **WHEN** anyone views a member's profile
- **THEN** no email, issuer or subject is present in the response

### Requirement: Display name chosen on first login
A new member SHALL choose a display name before using the forum. Names SHALL be 3–32 characters, unique case-insensitively, and unique after Unicode confusable normalisation.

#### Scenario: Confusable name rejected
- **WHEN** a new member picks "Admіn" (Cyrillic і) and a member "Admin" exists
- **THEN** the name is rejected as already taken

#### Scenario: Name required
- **WHEN** a new member without a display name calls any member API other than setting their name
- **THEN** the API responds 409 with code `display_name_required`

### Requirement: Display name changes with history
Members SHALL be able to change their display name within the limits of their group settings. Every change SHALL be recorded with old name, new name and time, and staff SHALL be able to view the history.

#### Scenario: Change within limit
- **WHEN** a member allowed 1 change per 30 days changes their name for the first time this period
- **THEN** the name changes, and the history shows the old and new names

#### Scenario: Change over limit
- **WHEN** they try a second change within the same 30 days
- **THEN** the change is rejected with the date the next change is allowed

### Requirement: Bootstrap administrators
Identities listed in the bootstrap configuration, by issuer and subject, SHALL be placed in the Administrators group on their first login.

#### Scenario: Bootstrap admin
- **WHEN** a configured bootstrap identity logs in for the first time
- **THEN** their new member is in the Administrators group

### Requirement: Guests are a group
Requests without a valid session SHALL be evaluated as members of the built-in Guests group.

#### Scenario: Guest permissions
- **WHEN** a request has no session
- **THEN** permission checks use the Guests group
