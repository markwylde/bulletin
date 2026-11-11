# Proposal

## Why

Members need to know when something they care about happens: replies, mentions, quotes,
messages and moderation outcomes. Plugins, webhooks and badges also need a reliable domain
event stream (ADR 0011).

## What Changes

- Notification, follow and digest subscribers on the outbox from `foundation-dev-environment`, plus the dead-letter screen.
- Follows: topics, forums and members, with per-follow delivery preferences.
- In-app notifications (bell, list, mark read), with authorisation rechecked at delivery.
- Email notifications and daily/weekly digests, localised, sent via SMTP.
- Notification preferences per type and channel.
- SSE stream for live counts, new-reply banners and session revocation, with replay via `Last-Event-ID`.

## Capabilities

### New Capabilities
- `domain-events` (modified): dead-letter visibility in the staff app.
- `notifications`: in-app and email notifications, preferences and digests.
- `follows`: following topics, forums and members.
- `realtime-stream`: live updates to open pages.

### Modified Capabilities
- None.

## Impact

- workers, user-api, user-app (bell, follow buttons, banner), email templates, `packages/domain/events`. Push is added in `pwa-push`.
