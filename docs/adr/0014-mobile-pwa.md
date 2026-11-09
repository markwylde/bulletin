# 0014 — Mobile-first and PWA

**Status:** Accepted (revised after review)

## Decision
- **Mobile-first**: every user-app and staff-app screen must look and work great at **360 px**
  width. Use touch targets ≥ 44 px, no hover-only interactions, and no horizontal scroll.
  Tables become cards. The editor is fully usable with mobile keyboards.
- **PWA** (user app): web manifest (themed), installable, service worker.
- **No forum content is stored offline.** The service worker caches only the app shell, static
  assets (content-hashed), fonts, and an offline page. Forum content can be revoked at any
  time, and an offline device cannot learn about a revocation, so persistent content caching
  would break the ADR 0006 exposure contract.
  - HTML, API, overlay and attachment responses are network-only in the service worker.
  - When offline, the member sees the shell with a localised offline page. Unsent editor
    drafts are kept in IndexedDB and submitted on reconnect; the member's own draft text is not
    revocable content.
  - On logout, account switch or session revocation, drafts and any client storage are cleared.
- **Web Push** (VAPID) is sent from workers, with per-type opt-in that mirrors notification
  preferences. Push payloads carry no content: just a notification ID and a generic localised
  title. The client fetches the details after authenticating. `mocks/push` is used locally.
  Subscriptions are Restricted data (ADR 0012).
- The staff app is responsive but is not a PWA.

## Consequences
- No offline reading. This is a deliberate trade-off for revocation safety.
- Real-device acceptance checks are required (ADR 0015).
