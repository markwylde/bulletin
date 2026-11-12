# Spec Delta

## Purpose

Lets members flag problems to staff and gives staff a shared place to triage, discuss and
resolve them.

## ADDED Requirements

### Requirement: Report content and members
Members SHALL report posts they can read, members' profiles, and private messages in their own conversations, with a reason category and optional comment. A member SHALL NOT report the same item twice while the report is open.

#### Scenario: Report post
- **WHEN** a member reports a post with reason "Spam"
- **THEN** a report is created and appears in the report centre

### Requirement: Report centre
Staff with report access SHALL see reports for content they moderate (and member and PM reports if they have `reports.members` or `reports.pms`), with status (open, in progress, resolved, rejected), assignee, staff comments, and links to take action.

#### Scenario: Forum moderator scope
- **WHEN** a forum moderator opens the report centre
- **THEN** they see reports for posts in forums they moderate, and not reports from other forums

### Requirement: Reported private messages
For a reported private message, staff with `reports.pms` SHALL see only the reported message and up to 5 preceding messages from that conversation. Each view SHALL be recorded in the moderation log.

#### Scenario: Limited PM context
- **WHEN** a moderator opens a PM report
- **THEN** they see the reported message plus up to 5 earlier messages, and nothing else from the conversation

### Requirement: Multiple reporters
Reports of the same item SHALL be grouped into one report showing all reporters, reasons and comments.

#### Scenario: Grouped
- **WHEN** three members report the same post
- **THEN** the report centre shows one report with three reporters

### Requirement: Outcome notification
When a report is resolved or rejected, reporters SHALL be notified of the outcome without revealing staff comments.

#### Scenario: Resolved
- **WHEN** staff resolve a report
- **THEN** each reporter receives a notification that their report was handled
