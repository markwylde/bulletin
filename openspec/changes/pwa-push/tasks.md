# Tasks

## 1. PWA

- [ ] 1.1 Per-theme manifest and icons, with a test that the manifest reflects theme colours
- [ ] 1.2 Service worker (shell precache, hashed assets, network-only content, offline page, versioned activation), with E2E tests for the offline-navigation, no-content-cached and new-version scenarios
- [ ] 1.3 Offline draft queue and reconnect prompt, plus local data clearing on logout, account switch, SSE `session_revoked` and non-reauth 401s, while keeping drafts on SSE `reauth_required` or `401 reauth_required`; E2E tests for the reconnect, revoked-session and reauth-keeps-draft scenarios

## 2. Push

- [ ] 2.1 Push subscription storage via `pii.save_push_subscription`, and the device list and removal UI via `pii.list_push_devices` and `pii.delete_push_device`; tests that the list never contains endpoints or keys, that a member cannot list or delete another member's device, and role denial on direct table access
- [ ] 2.2 Push channel in notification preferences, and the sender worker (send-time `can()` check, subscriptions only via `pii.delivery_target`, content-free payload, VAPID, 410 cleanup); tests against `mocks/push` for each scenario
- [ ] 2.3 Service worker push display and click handling (preview fetch, login fallback), with an E2E test via the mock

## 3. Real-device checklist

- [ ] 3.1 Write the real-device acceptance checklist (install, push, offline, editor input on iOS and Android) in `docs/qa/real-device.md`, and run it once

## 4. Strings and seed

- [ ] 4.1 Add en/es/fr strings for offline page, push titles, device list and prompts; verify completeness
- [ ] 4.2 Seed a push subscription for one seeded member against `mocks/push`, and verify a seeded PM triggers a captured push after `docker compose up --watch`

## 5. Feature flag

- [ ] 5.1 Register `pwa`, `web_push` with `defineFlag` (off in production defaults, on in the seed), gate routes with `requireFlag`, templates with `{% if flags.<key> %}` and islands with `useFlag`; tests that each surface is absent (404 or not rendered) when off, and a cache variant test for the flag toggle
