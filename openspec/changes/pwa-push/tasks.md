# Tasks

## 1. PWA

- [ ] 1.1 Per-theme manifest and icons, with a test that the manifest reflects theme colours
- [ ] 1.2 Service worker (shell precache, hashed assets, network-only content, offline page, versioned activation), with E2E tests for the offline-navigation, no-content-cached and new-version scenarios
- [ ] 1.3 Offline draft queue and reconnect prompt, plus local data clearing on logout, account switch, revocation and 401; E2E tests for the reconnect and revoked-session scenarios

## 2. Push

- [ ] 2.1 Push subscription storage via `pii` definer functions and the device list UI; tests including role denial on direct table access
- [ ] 2.2 Push channel in notification preferences, and the sender worker (send-time `can()` check, content-free payload, VAPID, 410 cleanup); tests against `mocks/push` for each scenario
- [ ] 2.3 Service worker push display and click handling (preview fetch, login fallback), with an E2E test via the mock

## 3. Real-device checklist

- [ ] 3.1 Write the real-device acceptance checklist (install, push, offline, editor input on iOS and Android) in `docs/qa/real-device.md`, and run it once

## 4. Strings and seed

- [ ] 4.1 Add en/es/fr strings for offline page, push titles, device list and prompts; verify completeness
- [ ] 4.2 Seed a push subscription for one seeded member against `mocks/push`, and verify a seeded PM triggers a captured push after `docker compose up --watch`
