# Tasks

## 1. Model and access

- [x] 1.1 Migrations for conversations, participants and messages; a participant-only repository; integration tests for the non-participant and admin-without-report 404 scenarios
- [x] 1.2 Start-conversation mutation (group permission, recipient limit, ignore check, restricted senders, daily limit, quota) emitting `pm.sent`; tests for each rejection scenario

## 2. Conversation features

- [ ] 2.1 Reply, invite, remove, leave (ends all access, frees a quota slot) and block re-invites, plus full history for new participants; integration tests for each scenario, including 404 after leaving
- [ ] 2.2 Inbox, Sent and Archive folders, unread tracking, archive/unarchive with auto-unarchive on reply; integration tests; E2E at 360 and 1440
- [ ] 2.3 Search within own conversations, with a test that results never include others' conversations
- [ ] 2.4 `conversation_message_holds` table and the permanent removal job (deletes unheld messages and attachment objects; keeps the conversation row, held messages and their attachments while holds exist; finishes on hold release); integration tests with no holds and with fixture holds

## 3. Integrations

- [ ] 3.1 Attachments in conversations (participant-based upload/download checks), with permission-denial tests
- [ ] 3.2 Notifications and SSE live replies for conversations, with an E2E live-reply test

## 4. Strings and seed

- [ ] 4.1 Add en/es/fr strings for conversations UI, errors and notifications; verify completeness
- [ ] 4.2 Seed conversations (1:1 and group, archived, with attachments, one where a participant left) for seeded members; verify after `docker compose up --watch`

## 5. Feature flag

- [ ] 5.1 Register `conversations` with `defineFlag` (off in production defaults, on in the seed), gate routes with `requireFlag`, templates with `{% if flags.<key> %}` and islands with `useFlag`; tests that each surface is absent (404 or not rendered) when off, and a cache variant test for the flag toggle
