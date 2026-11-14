# Spec Delta

## Purpose

Gives members control over their personal data and keeps the board compliant: personal data
is minimised, protected, retained only as long as configured, and exportable or erasable on request.

## ADDED Requirements

### Requirement: Retention policies
Admins SHALL configure retention for IP logs, session metadata, revoked sessions, the PII access log, exports and IP bans, with defaults of 90 days, 30 days, 7 days, 2 years, 7 days and 1 year respectively. Expired data SHALL be removed or anonymised nightly.

#### Scenario: IP log expiry
- **WHEN** IP log retention is 90 days and the nightly job runs
- **THEN** no IP log entry older than 90 days remains

### Requirement: Data export
Members SHALL request an export of their personal data. They SHALL receive, by notification and email, an expiring link to a file containing their profile, settings, posts, conversations they participate in, reactions, follows, warnings visible to them, and their attachments, plus data from plugins holding their personal data.

#### Scenario: Export ready
- **WHEN** a member requests an export
- **THEN** within 24 hours they receive a link valid for 7 days to download the archive

#### Scenario: Link expired
- **WHEN** the member opens the link after 7 days
- **THEN** the download is refused, and the file no longer exists

### Requirement: Erasure
Members SHALL request erasure of their account. Once processed, their restricted data, drafts, revisions, attachments, notifications, reactions, follows, friendships and profile data SHALL be removed, and the member shown as "Deleted member #n". Admins SHALL choose whether their posts are kept anonymised or deleted.

#### Scenario: Erasure with anonymised posts
- **WHEN** an erasure is processed with "keep posts anonymised"
- **THEN** the posts remain attributed to "Deleted member #n", and no profile, email, IP or avatar remains

#### Scenario: Plugin data erased
- **WHEN** an erasure is processed and a plugin holds that member's data
- **THEN** the plugin's erase hook runs, and its completion is recorded

#### Scenario: Nothing recreated during erasure
- **WHEN** an erasure is in progress and a queued job or a still-open browser tries to write data for that member
- **THEN** the write is refused or skipped, and no personal data for the member exists when the erasure completes

#### Scenario: Old name not discoverable
- **WHEN** an erasure completes for a member who was mentioned in other members' posts and had renamed once
- **THEN** neither their current nor their previous display name appears in any post, profile URL or name history

### Requirement: Retained records disclosed
When records are retained after erasure on a documented basis (for example an active ban or the moderation log), the member SHALL be told which categories are retained and why.

#### Scenario: Active ban retained
- **WHEN** a banned member requests erasure
- **THEN** the confirmation lists the ban record as retained, with the stated basis

### Requirement: Staff request queue
Staff with `privacy.requests` SHALL see export and erasure requests with status and due date (30 days from request), process or reject them with a reason, and see overdue requests highlighted.

#### Scenario: Overdue
- **WHEN** a request is 25 days old and unprocessed
- **THEN** it is highlighted as due soon

### Requirement: PII access audit
Every access to restricted personal data SHALL be recorded before the data is returned. Admins with `privacy.audit` SHALL view the access log filtered by actor, subject member, purpose and date.

#### Scenario: Audit view
- **WHEN** an admin filters the PII access log by a moderator
- **THEN** they see each IP lookup that moderator performed, with purpose and time

### Requirement: Restricted data unreachable except by audited functions
Application database roles SHALL have no direct access to restricted-data tables. Access SHALL be possible only through designated functions, which verify the actor's session and permission.

#### Scenario: Direct query denied
- **WHEN** the user API's database role runs a direct SELECT on a restricted table
- **THEN** the query fails with a permission error

### Requirement: Personal-data inventory enforced
Every database column holding personal data SHALL be listed in the personal-data inventory. The build SHALL fail if a column marked personal is missing from it.

#### Scenario: Unlisted column
- **WHEN** a migration adds a column tagged `@personal` that is not in the inventory
- **THEN** `bun run check` fails, naming the column
