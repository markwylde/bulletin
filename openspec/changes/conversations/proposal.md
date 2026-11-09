# Proposal

## Why

You confirmed private messaging as multi-participant conversations (IPB's "Personal
Conversations"). Members need private discussions with quotas, invitations and safety controls.

## What Changes

- Conversations with a title, multiple participants, replies, and the editor (attachments if allowed).
- Inviting and removing participants (by the starter), leaving, and blocking re-invites.
- Unread tracking, an inbox with folders (inbox, sent, archive), and search within one's own conversations.
- Group limits: can use PMs, max recipients, daily new conversations, conversation quota (number of conversations kept).
- Ignore-list integration, and protection from contact by banned or suspended members.
- Notifications via the event pipeline, and live updates via SSE.
- Moderator access only through reported messages (handled in `moderation`).

## Capabilities

### New Capabilities
- `conversations`: private, multi-participant conversations between members.

### Modified Capabilities
- None.

## Impact

- Schema, user-app conversation routes, notifications, SSE, attachments (conversation context).
