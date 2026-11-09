# Tasks

## 1. Schema and PII functions

- [x] 1.1 Migrations for `core.members` (no identity columns; `locale`, `is_service`, `previous_visit_at`, `last_active_at`), `core.groups` (seeded built-ins), `core.member_groups`, `core.member_name_history`, `core.sessions` (bigint ID, unique `token_hash`, `rotate_pending`), `core.session_grants`, `core.login_challenges`; verify with integration tests
- [ ] 1.2 Migrations for `pii.identities`, `pii.session_meta`, `pii.ip_log` and `pii.access_log` with RLS forced, plus the system-purpose definer functions `pii.resolve_identity`, `pii.record_session_meta` and `pii.record_login_ip` granted per ADR 0012; verify role-denial tests (no app role can SELECT `pii` tables, and each function is executable only by its listed roles)
- [ ] 1.3 Add `pii.list_own_sessions(session_token)` (the member's own sessions with IP and browser family, audited as own-data access) for the sessions list, with role-denial tests

## 2. Login flow

- [ ] 2.1 Implement `POST /api/auth/challenge` and `POST /api/auth/session` (JWKS verification, nonce/challenge binding, single use) on user-api and staff-api, with integration tests for the success, replay and login-CSRF scenarios
- [ ] 2.2 Integrate `@darkauth/client` in the staff app and in the user app's script-only login button and `/auth/callback` transit route (no themed pages), plus `GET /api/auth/session` returning the CSRF token on user-api and staff-api; E2E login as each seeded profile at 360 and 1440, and add the `loginAs` E2E helper
- [ ] 2.3 Implement member creation on first login and bootstrap admins, with integration tests for the first, returning and bootstrap scenarios

## 3. Sessions

- [ ] 3.1 Implement session lookup, cache and revocation NOTIFY, and lifetimes, with integration tests for the expiry scenarios
- [ ] 3.2 Implement top-level silent re-auth (user-app redirect to user-api `/api/auth/refresh` and `/api/auth/callback` with a server-held PKCE verifier, `prompt=none`, `return_to` validation) and the 2 h background grace with `reauth_required`, plus the client fetch wrapper that keeps unsent request bodies; tests against the test-only protected endpoint for the successful, disabled-account, within-grace and after-grace scenarios
- [ ] 3.3 Implement rotation on login and on group change (`rotate_pending`, new token on the next user-api response, 60 s overlap), with integration tests including old-token expiry
- [ ] 3.4 Implement logout and the "revoke all sessions" staff endpoint (permission-checked), with tests including a permission-denial case
- [ ] 3.5 Implement staff step-up (`max_age=0` challenge, `auth_time` within 60 s, `last_auth_at` update, SPA flow) against the test-only sensitive endpoint, with integration tests including the old-IdP-session scenario and an E2E test; add `max_age` and `auth_time` support to darkauth-mock
- [ ] 3.6 Track `last_active_at` and roll it into `previous_visit_at` after 30 minutes of inactivity (used by search's "new since last visit"), with an integration test

## 4. CSRF and headers

- [ ] 4.1 Implement Origin and CSRF middleware for all non-GET app API routes with the named ADR 0018 exemptions (challenge, session, beacon, overlay, signed unsubscribe) as an explicit allowlist, with tests for missing/invalid token, wrong Origin, and that no other route can be exempted
- [ ] 4.2 Implement security headers (CSP nonce plumbing for Astro and the staff app) and verify with header tests on representative routes

## 5. Display names

- [ ] 5.1 Implement the display-name API (UTS #39 skeleton uniqueness, length rules, `display_name_required` guard on member APIs) with unit tests for confusables and integration tests for the guard; the step page lands in `rendering-and-caching`
- [ ] 5.2 Implement name changes with a constant frequency limit (replaced by a group setting in `groups-permissions`) and history, plus a staff history view endpoint behind a permission check, with tests for the within/over-limit scenarios and a permission-denial test
- [ ] 5.3 Member locale preference (`core.members.locale`, save endpoint, resolution for member requests) with integration tests for both scenarios; seed one es and one fr member

## 6. Strings and seed

- [ ] 6.1 Add en/es/fr strings for login, logout, display name and errors; verify completeness
- [ ] 6.2 Seed members for every darkauth-mock profile (matching subjects), including name history for one member, and verify each profile logs in after `docker compose up --watch`
