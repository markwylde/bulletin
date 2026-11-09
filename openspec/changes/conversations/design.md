# Design

## Context

Conversations are personal data (ADR 0012 "personal content") and are never cached in
shared fragments.

## Goals / Non-Goals

**Goals:** a strict participant-only access check; reuse of the editor, attachments and the
event pipeline.

**Non-Goals:** encryption at rest beyond the database's; real-time typing indicators.

## Decisions

- **Schema**:
  - `conversations(id, title, starter_id, created_at, last_message_at)`
  - `conversation_participants(conversation_id, member_id, state enum(active, left, removed),
    joined_at, left_at, last_read_message_id, folder enum(inbox, archive), block_reinvite)`
  - `conversation_messages(id, conversation_id, author_id, body_md, body_html, body_text,
    created_at)`
- **Access**: every query joins `conversation_participants` with `state = 'active'`. Messages
  are filtered by `created_at <= left_at` for past participants (who lose access entirely in
  the UI). Unknown and unauthorised IDs both return 404.
- **No shared caching**: conversation routes and APIs are `Cache-Control: private, no-store`,
  bypass the shared fragment LRU entirely, and are never CDN-eligible. Templates still come
  from the theme.
- **Quotes**: messages may quote only messages from the same conversation, and forum posts can
  never quote messages (enforced by the content pipeline, ADR 0007).
- **Report access**: the moderation change adds a narrow `report_access` check (report ID →
  message IDs plus context window), not a general staff bypass.
- **Search**: Postgres FTS over messages, restricted by the participant join (ADR 0017 config).
- **Attachments**: the upload context `conversation:{id}` checks participation instead of forum `upload`.

## Risks / Trade-offs

- [Spam via group conversations] → daily start limits and recipient caps from group settings; the content-filter stages apply.
