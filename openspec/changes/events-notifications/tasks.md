# Tasks

## 1. Event pipeline

- [ ] 1.1 Migrations for events, event_deliveries and job_cursors; implement the catalog and the `emit()` helper inside `runMutation`; integration test for the rolled-back scenario
- [ ] 1.2 Implement the relay (claim, per-subscriber delivery rows, singleton enqueue, published marking), with tests for subscriber isolation and crash-between-steps deduplication
- [ ] 1.3 Add the dead-letter list and retry in the staff app, with integration tests and permission denial
- [ ] 1.4 Retrofit `topics-posts` mutations to emit events, with tests asserting payloads carry IDs only

## 2. Follows

- [ ] 2.1 Migrations and API for follows (topic, forum, member), auto-follow preference, and follows page; integration tests including the inaccessible-content scenario
- [ ] 2.2 Follow buttons via the overlay, with a test that shared HTML contains no follow state; E2E at 360 and 1440

## 3. Notifications

- [ ] 3.1 Notifications subscriber (recipient computation, `can()` check at delivery, a recipient-filter extension point used later by the ignore list, coalescing), with tests for the mention and access-lost scenarios
- [ ] 3.2 Notification centre UI (bell, list, open, mark all read), with E2E at all viewports
- [ ] 3.3 Preferences page per type and channel, with integration tests
- [ ] 3.4 Email sending (SMTP client, localised templates, quote-free text, signed unsubscribe) with addresses obtained only via `pii.delivery_target` (workers-only grant, audited per call, refuses delivered or disabled notifications); tests against the mail mock, plus tests that workers cannot read `pii.identities` directly and cannot look up arbitrary members
- [ ] 3.5 Daily and weekly digests (cron, build-time permissions), with integration tests

## 4. Realtime

- [ ] 4.1 SSE endpoint (session validation, LISTEN wake-up, durable reads, cursor IDs, replay or resync, heartbeat), with integration tests for short/long disconnect and the hidden-forum scenario
- [ ] 4.2 Client stream handler (count updates, new-replies banner, logout on revocation), with E2E for the banner and revocation scenarios

## 5. Strings and seed

- [ ] 5.1 Add en/es/fr strings for notification texts, emails, digests, preferences and banners; verify completeness
- [ ] 5.2 Seed follows, notifications (read and unread) and digest preferences for seeded members, and verify the bell shows counts after `docker compose up --watch`
