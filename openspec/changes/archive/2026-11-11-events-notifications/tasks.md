# Tasks

## 1. Event pipeline

- [x] 1.1 Add the notification, follow and digest event types to the catalog (the outbox, relay and `emit()` exist from `foundation-dev-environment`)
- [x] 1.2 Dead-letter list and retry in the staff app, with tests for the retry scenario and permission denial
- [x] 1.3 Add the dead-letter list and retry in the staff app, with integration tests and permission denial
- [x] 1.4 Subscribe notifications to the events `topics-posts` and `groups-permissions` already emit (`post.created`, `topic.created`, `member.promoted`), with tests asserting payloads carry IDs only and that a promotion notifies the member

## 2. Follows

- [x] 2.1 Migrations and API for follows (topic, forum, member), auto-follow preference, and follows page; integration tests including the inaccessible-content scenario
- [x] 2.2 Follow buttons via the overlay, with a test that shared HTML contains no follow state; E2E at 360 and 1440

## 3. Notifications

- [x] 3.1 Notifications subscriber (recipient computation, `can()` check at delivery, a recipient-filter extension point used later by the ignore list, coalescing), with tests for the mention and access-lost scenarios
- [x] 3.2 Notification centre UI (bell, list, open, mark all read), with E2E at all viewports
- [x] 3.3 Preferences page per type and channel, with integration tests
- [x] 3.4 Email sending (SMTP client, localised templates, quote-free text, signed unsubscribe) with addresses obtained only via `pii.delivery_target` (workers-only grant, audited per call, refuses delivered or disabled notifications); tests against the mail mock, plus tests that workers cannot read `pii.identities` directly and cannot look up arbitrary members
- [x] 3.5 Daily and weekly digests (cron, build-time permissions), with integration tests

## 4. Realtime

- [x] 4.1 SSE endpoint (session validation, LISTEN wake-up, durable reads, cursor IDs, replay or resync, heartbeat), with integration tests for short/long disconnect and the hidden-forum scenario
- [x] 4.2 Control events `resync`, `session_revoked` and `reauth_required` with the shared client handlers, defined in one typed contract; integration tests for revocation and grace expiry, and an E2E that a revoked session's open page switches to logged out
- [x] 4.3 Client stream handler (count updates, new-replies banner, logout on revocation), with E2E for the banner and revocation scenarios

## 5. Strings and seed

- [x] 5.1 Add en/es/fr strings for notification texts, emails, digests, preferences and banners; verify completeness
- [x] 5.2 Seed follows, notifications (read and unread) and digest preferences for seeded members, and verify the bell shows counts after `docker compose up --watch`

## 6. Email

- [x] 6.1 `core.delivery_intents` for notifications, digests and system mail, with `pii.delivery_target(intent_id, channel)`; tests for the digest-with-notifications-off scenario and that an erasing member gets nothing
- [x] 6.2 Unsubscribe confirmation page plus `POST /api/notifications/unsubscribe` with signed tokens and RFC 8058 headers; tests for the click-and-confirm and link-scanner scenarios

## 7. Feature flag

- [x] 7.1 Register `notifications`, `follows`, `digests`, `realtime` with `defineFlag` (off in production defaults, on in the seed), gate routes with `requireFlag`, templates with `{% if flags.<key> %}` and islands with `useFlag`; tests that each surface is absent (404 or not rendered) when off, and a cache variant test for the flag toggle
