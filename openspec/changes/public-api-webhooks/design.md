# Design

## Context

ADR 0016. Webhooks are subscribers in the event relay (change `events-notifications`).

## Goals / Non-Goals

**Goals:** one route-schema source for validation and OpenAPI; identical permission logic to the apps.

**Non-Goals:** GraphQL; OAuth for third-party apps (keys only in v1).

## Decisions

- **Route schemas**: valibot schemas on each `/api/v1` route generate OpenAPI 3.1 at build
  time. Docs are rendered with a static Scalar/Redoc bundle served from our origin.
- **Keys**: format `blt_<8-char prefix>_<32 random bytes base64url>`. Stored as
  `sha256(pepper || key)`, indexed by prefix. `api_keys(id, prefix, hash, principal_member_id,
  scopes, expires_at, revoked_at, last_used_at)`. `last_used_at` is updated at most once per minute.
- **Service members**: real members flagged `is_service`, excluded from member lists and
  leaderboards, with no login.
- **Rate limiting**: an UNLOGGED `rate_buckets(key, window_start, count)` with an atomic
  upsert per request, using a sliding window approximated by two fixed windows.
- **Webhooks**: `webhooks(id, url, secret, events, principal_member_id, content_fields,
  enabled)` and `webhook_deliveries(id, webhook_id, event_id, attempt, status, response_ms,
  created_at)`. Delivery runs as a pg-boss job with a backoff schedule. SSRF is checked at
  config time and again at delivery after DNS resolution.

## Risks / Trade-offs

- [Key leakage] → shown once, prefix visible for identification, quick revocation, and last-used for detection.

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| API keys (`api_keys`) | Security record | integrations | until revoked or expired | key owner and admins; hash only | key metadata included | revoked and deleted |
| Webhook delivery logs | Derived (IDs only) | debugging | 30 days | admins | excluded | age out |
| Rate buckets | Derived | limits | 2 windows | none | — | — |

## Feature flags (ADR 0010)

`public_api`, `webhooks`.

Gating: server routes use `requireFlag(key)` (404 when off), templates use `{% if flags.<key> %}`, and islands use `useFlag(key)`. Flags marked `affectsRender` are part of the cache variant (ADR 0006, 0010).
