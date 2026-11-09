# 0014 — Mobile-first and PWA

**Status:** Accepted (revised after review)

## Decision
- **Mobile-first**: every user-app and staff-app screen must look and work great at **360 px**
  width. Use touch targets ≥ 44 px, no hover-only interactions, and no horizontal scroll.
  Tables become cards. The editor is fully usable with mobile keyboards.
- **PWA** (user app): web manifest (themed), installable, service worker.
- **Offline storage is public-only**:
  - The service worker caches the app shell, static assets, and responses explicitly marked
    `X-Bulletin-Offline: public`. Only guest-visible content gets this mark.
  - Private forums, PMs, moderation pages, the ACP, overlay JSON and attachments from non-public
    forums are **never** stored offline.
  - The offline cache is partitioned by member ID and **cleared on logout, on account switch
    and on session revocation** (signalled via SSE or a 401).
  - Maximum age is 7 days. HTML strategy is network-first.
- **Web Push** (VAPID) is sent from workers, with per-type opt-in that mirrors notification
  preferences. Push payloads carry no content: just a notification ID and a generic localised
  title. The client fetches the details after authenticating. `mocks/push` is used locally.
  Subscriptions are Restricted data (ADR 0012).
- The staff app is responsive but is not a PWA.

## Consequences
- Offline reading is limited to public content; this is a deliberate trade-off.
- Real-device acceptance checks are required (ADR 0015).
