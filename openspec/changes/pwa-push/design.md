# Design

## Context

ADR 0014; push subscriptions are restricted data (ADR 0012). Notifications already have a
channel model (change 12).

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
  page on logout, account switch, or the SSE `session_revoked` event, and on a 401.
- **Manifest**: generated per theme (`/manifest.webmanifest?theme=<id>@<ver>`), cached with the theme tag.
- **Push**: VAPID keys from config (dev defaults). Subscriptions are stored via
  `pii.save_push_subscription` (definer, user_api only). The sender reads them only via
  `pii.delivery_target(notification_id, 'push')` (workers only, audited). The sender worker uses `web-push`-compatible
  encryption (the `@block65/webcrypto-web-push` library or a small internal implementation on
  Bun's WebCrypto). Payload: `{ n: notificationId, t: titleKey }`. The service worker fetches
  `/api/notifications/:id/preview` with credentials to show details.
- **Mock**: `mocks/push` acts as the push service endpoint, decrypts payloads with test keys,
  and shows them.

## Risks / Trade-offs

- [iOS PWA push limitations] → covered by the real-device checklist (ADR 0015).
