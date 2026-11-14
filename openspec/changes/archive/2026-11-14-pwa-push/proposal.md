# Proposal

## Why

You want the user app installable as a PWA with push notifications. ADR 0014 limits offline
storage to the app shell and unsent drafts, for revocation safety.

## What Changes

- Web app manifest (themed by the active theme), install prompt and icons.
- Service worker: app shell and static asset caching, offline page, network-only for content, draft queue in IndexedDB, and storage clearing on logout or revocation.
- Web Push (VAPID): subscription management per device, per-type opt-in mirroring notification preferences, content-free payloads, and a mock in dev.
- Notification click handling: open the relevant page after authentication.

## Capabilities

### New Capabilities
- `pwa`: installability and offline behaviour of the user app.
- `web-push`: push notifications to members' devices.

### Modified Capabilities
- None.

## Impact

- user-app (manifest, service worker, settings), workers (push sender), `pii` (push subscriptions), the push mock.
