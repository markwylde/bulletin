# Design

## Context

ADR 0014; push subscriptions are restricted data (ADR 0012). Notifications already have a
channel model (change `events-notifications`).

## Goals / Non-Goals

**Goals:** a minimal, safe service worker; push as just another channel.

**Non-Goals:** offline reading (rejected in ADR 0014); native apps.

## Decisions

- **Service worker**: hand-written (≈ 150 lines, no Workbox), versioned by build hash.
  Precaches the shell and hashed assets on install. A fetch handler serves hashed assets
  cache-first; everything else is network-only, with the offline page as fallback for
  navigations. The old cache is deleted on activate.
- **Drafts offline**: the editor island writes to IndexedDB when a submit fails due to
  network loss. On `online`, it prompts. IndexedDB is cleared via a `postMessage` from the
  page on logout, account switch, or the SSE `session_revoked` event, and on a 401 that is not
  `reauth_required`. On the SSE `reauth_required` event or a `401 reauth_required`, IndexedDB
  drafts are **kept** (the same member is continuing) and the continue prompt is shown.
- **Manifest**: generated per theme (`/manifest.webmanifest?theme=<id>@<ver>`), cached with the theme tag.
- **Push**: VAPID keys from config (dev defaults). Subscriptions are stored via
  `pii.save_push_subscription` (definer, user_api only). The device list in notification
  settings comes from `pii.list_push_devices(session_token)`, which returns only the member's
  own non-secret metadata (label, browser family, created and last-used times), and removal uses
  `pii.delete_push_device(session_token, device_id)`. Endpoints and keys never leave `pii`
  except through `pii.delivery_target`. The sender reads them only via
  `pii.delivery_target(intent_id, 'push')` (workers only, audited). The sender worker uses the `web-push` library
  (allowed in ADR 0001) for VAPID signing and payload encryption. Payload: `{ n: notificationId, t: titleKey }`. The service worker fetches
  `/api/notifications/:id/preview` with credentials to show details.
- **Endpoint safety**: a subscription endpoint is client-supplied, so it is validated on save
  (HTTPS, public host, no credentials or unusual ports) and every send goes through `safeFetch`
  (ADR 0016) with no redirects. `mocks/push` is reachable only via the dev allowlist.
- **Mock**: `mocks/push` acts as the push service endpoint, decrypts payloads with test keys,
  and shows them.

## Risks / Trade-offs

- [iOS PWA push limitations] → covered by the real-device checklist (ADR 0015).

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| Push subscriptions (endpoint, keys) | Restricted | push delivery | until unsubscribed, expired (HTTP 404/410) or session revoked | `pii.save_push_subscription`, `pii.list_push_devices`, `pii.delete_push_device`, `pii.delivery_target` | device labels included; keys never | deleted |
| Offline drafts (IndexedDB) | Personal content, client only | unsent work | until sent, logout or session revocation | the device only | not held server-side | cleared on logout and revocation |

## Feature flags (ADR 0010)

`pwa` (manifest and service worker), `web_push`.

Gating: server routes use `requireFlag(key)` (404 when off), templates use `{% if flags.<key> %}`, and islands use `useFlag(key)`. Flags marked `affectsRender` are part of the cache variant (ADR 0006, 0010).
