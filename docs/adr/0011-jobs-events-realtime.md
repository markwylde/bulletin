# 0011 — Background work, events and realtime

**Status:** Accepted (revised after review)

## Decision
### Jobs
- **pg-boss for all background work**, consumed by `apps/workers`. Queues: notifications,
  email, digests (cron), push, unfurls, re-render, counters/materialisations, auto-promotion,
  badge rules, warning expiry, retention purges, exports/erasure, webhooks, CDN purge,
  attachment processing/orphans, plugin events/jobs.
- Jobs are idempotent, with retries, backoff and dead letters visible in the staff app.
- **Job payloads carry IDs only** (no content, no PII). Workers load current state.

### Events: transactional outbox
- Domain writes insert into `core.events(id bigserial, type, aggregate_type, aggregate_id,
  aggregate_version, payload_ids, created_at)` **in the same transaction**.
- A relay claims unpublished rows with `FOR UPDATE SKIP LOCKED`. For each subscriber (core
  handlers, each enabled plugin, each webhook), it inserts
  `core.event_deliveries(event_id, subscriber)` (unique) and enqueues one job per delivery with
  `singletonKey = event_id:subscriber`. It then marks the event published. A crash between
  steps only re-runs idempotent inserts.
- **Ordering**: not guaranteed across events. Consumers that care compare `aggregate_version`
  and ignore stale events.
- Delivery semantics are at-least-once. Consumers deduplicate by `event_id`.

### Notifications
- In-app notifications live in `core.notifications` (durable). Delivery to email, push and
  digest follows per-type member preferences.
- **Authorisation is rechecked at delivery time.** The worker runs `can(recipient, read,
  resource)` when sending, not when the event happened. Digests are built at send time.
- Covers follows (topic/forum/member), mentions, quotes, replies, PMs, reactions,
  reputation, badges, warnings and moderation outcomes.
- Email: SMTP (`mocks/mail` locally), localised (ADR 0013).

### Realtime (SSE)
- `GET /api/stream` on user-api. No WebSockets.
- `NOTIFY` only wakes API processes. Processes then read durable state
  (`core.notifications`, topic last-post IDs) and filter by subscriber and `can()`.
- Each SSE message has an `id` (notification ID or a monotonic cursor). On reconnect with
  `Last-Event-ID`, the server replays from durable state. If the gap is too large, it sends
  `resync` and the client refetches the overlay.
- The session is validated on connect and every 60 s. Session revocation (logout,
  ban, staff kill) closes the stream within 60 s, or immediately via NOTIFY.
- Streams send a heartbeat every 25 s and close on SIGTERM with `retry:` (ADR 0020).

## Consequences
- Workers scale independently; all crons are pg-boss schedules.
