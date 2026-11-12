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
- **Access**: every query joins `conversation_participants` with `state = 'active'`. Leaving
  or removal sets `state` to `left` or `removed` and ends all access, including history; there
  is no separate per-member delete. Unknown and unauthorised IDs both return 404. The `left`
  row is kept only to enforce `block_reinvite`.
- **Quota**: counts the member's `active` participations. Leaving frees a slot.
- **Holds**: this change owns `conversation_message_holds(message_id, holder, ref,
  created_at)`, a generic retention hold. Nothing creates holds until `moderation`, which
  inserts one per message in `report_pm_access` when a PM report opens and deletes them when it
  closes. Holds are the only way to keep messages past removal.
- **Permanent removal**: when the last `active` participant leaves, a job deletes every
  unheld message and its attachment objects. If any holds remain, it keeps the minimum: the
  conversation row (title kept, starter link kept for the report), the held messages and their
  attachments. When the last hold is released, the same job finishes removal. The job is
  idempotent and runs again on hold release.
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

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| Messages, titles, participants | Personal content | private messaging | until no participant remains, then permanently removed (unless an open report holds them) | participants only; staff only via `report_pm_access` | the member's own messages and the conversations they are still in | own messages anonymised where other participants remain; deleted otherwise |
| Read state and folders | Personal content | inbox UX | life of participation | the member only | included | deleted |

## Feature flags (ADR 0010)

`conversations`.

Gating: server routes use `requireFlag(key)` (404 when off), templates use `{% if flags.<key> %}`, and islands use `useFlag(key)`. Flags marked `affectsRender` are part of the cache variant (ADR 0006, 0010).
