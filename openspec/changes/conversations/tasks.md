# Tasks

## 1. Model and access

- [ ] 1.1 Migrations for conversations, participants and messages; a participant-only repository; integration tests for the non-participant and admin-without-report 404 scenarios
- [ ] 1.2 Start-conversation mutation (group permission, recipient limit, ignore check, restricted senders, daily limit, quota) emitting `pm.sent`; tests for each rejection scenario

## 2. Conversation features

- [ ] 2.1 Reply, invite, remove, leave and block re-invites, plus full history for new participants; integration tests for each scenario
- [ ] 2.2 Inbox, Sent and Archive folders, unread tracking, archive/unarchive with auto-unarchive on reply; integration tests; E2E at 360 and 1440
- [ ] 2.3 Search within own conversations, with a test that results never include others' conversations
- [ ] 2.4 Deletion from own view and permanent removal when no participants remain (respecting open reports); integration tests

## 3. Integrations

- [ ] 3.1 Attachments in conversations (participant-based upload/download checks), with permission-denial tests
- [ ] 3.2 Notifications and SSE live replies for conversations, with an E2E live-reply test

## 4. Strings and seed

- [ ] 4.1 Add en/es/fr strings for conversations UI, errors and notifications; verify completeness
- [ ] 4.2 Seed conversations (1:1 and group, archived, with attachments, one where a participant left) for seeded members; verify after `docker compose up --watch`
