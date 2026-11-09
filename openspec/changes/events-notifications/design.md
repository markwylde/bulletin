# Design

## Context

ADR 0011 defines the outbox, deliveries and SSE semantics; ADR 0003 defines LISTEN as
wake-up only.

## Goals / Non-Goals

**Goals:** one event pipeline for core subscribers now, and for webhooks and plugins later
(they register as subscribers).

**Non-Goals:** push (change 22); webhooks (change 21); plugin subscribers (change 19).

## Decisions

- **Catalog**: `packages/domain/events/catalog.ts` defines each type with a payload schema
  (IDs only) and a version. Types include `topic.created`, `post.created`, `post.edited`,
  `post.deleted`, `post.restored`, `post.approved`, `member.created`, `member.promoted`,
  `pm.sent`, `reaction.added`, `report.created`, `warning.issued`, `badge.awarded`, and
  more as features land.
- **Relay**: a worker loop, woken by `NOTIFY events_new` with a 1 s poll fallback. It claims
  up to 100 rows `FOR UPDATE SKIP LOCKED` and, for each subscriber matching the type, inserts
  `event_deliveries(event_id, subscriber) ON CONFLICT DO NOTHING` and sends
  `boss.send(queueFor(subscriber), {eventId}, {singletonKey})`. It then sets
  `published_at`.
- **Notifications fan-out**: subscriber `notifications`. It computes recipients (followers,
  mentioned, quoted, PM participants), then for each recipient checks `can(read)` and the
  ignore list, coalesces, and inserts `core.notifications`. Email is enqueued per recipient
  preference.
- **Digests**: pg-boss cron at 07:00 board time (daily) and Monday (weekly). It builds per
  member from `follows` plus content since `last_digest_at`, with `can()` at build time.
- **SSE**:
  - Each user-api process keeps one LISTEN connection on channels `notify_member` (payload:
    member ID) and `topic_activity` (payload: topic ID).
  - Connected clients are indexed by member and by topic subscription.
  - On wake, the process reads durable state (`notifications` since cursor; topic posts
    since the client's last position, filtered by `can()`).
  - The event `id` is a composite cursor `n:<notifId>|t:<postId>`. The replay limit is
    200 events or 1 h; beyond that it sends `resync`.
- **Unsubscribe links**: an HMAC-signed token of `(member, type, expires)`.
- **Recipient addresses**: workers never read `pii` tables. The email job calls
  `pii.delivery_target(notification_id, 'email')` (ADR 0012), which returns that recipient's
  address only if the notification is undelivered and email is still enabled for it, and
  writes the audit row in the same transaction as the delivery record.
- **Email**: SMTP via a small client (Bun TCP). Templates use the same i18n catalogs, with
  plain text and HTML parts.

## Risks / Trade-offs

- [Fan-out to forums with thousands of followers] → chunked jobs per 500 recipients.
- [Many idle SSE connections] → heartbeats every 25 s; connection count is a metric with a per-process cap.
