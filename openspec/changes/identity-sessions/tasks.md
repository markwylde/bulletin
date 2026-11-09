# Tasks

## 1. Schema and PII functions

- [ ] 1.1 Migrations for `core.members` (no identity columns), `core.groups` (seeded built-ins), `core.member_groups`, `core.member_name_history`, `core.sessions`, `core.session_grants`, `core.login_challenges`; verify with integration tests
- [ ] 1.2 Migrations for `pii.identities`, `pii.session_meta`, `pii.ip_log` and `pii.access_log` with RLS forced, plus the system-purpose definer functions `pii.resolve_identity`, `pii.record_session_meta` and `pii.record_login_ip` granted per ADR 0012; verify role-denial tests (no app role can SELECT `pii` tables, and each function is executable only by its listed roles)

## 2. Login flow

- [ ] 2.1 Implement `POST /api/auth/challenge` and `POST /api/auth/session` (JWKS verification, nonce/challenge binding, single use) on user-api and staff-api, with integration tests for the success, replay and login-CSRF scenarios
- [ ] 2.2 Integrate `@darkauth/client` in the user app and staff app login/callback pages; E2E login as each seeded profile at all viewports
- [ ] 2.3 Implement member creation on first login and bootstrap admins, with integration tests for the first, returning and bootstrap scenarios

## 3. Sessions

- [ ] 3.1 Implement session lookup, cache and revocation NOTIFY, and lifetimes, with integration tests for the expiry scenarios
- [ ] 3.5 Implement top-level silent re-auth (`/auth/refresh`, `prompt=none`, `return_to` validation) and the 2 h background grace with `reauth_required`, plus the client fetch wrapper that preserves editor content; tests for the successful, disabled-account, within-grace and after-grace scenarios, and an E2E for the after-grace reply
- [ ] 3.2 Implement rotation on login and on group change, with an integration test
- [ ] 3.3 Implement logout and the "revoke all sessions" staff endpoint (permission-checked), with tests including a permission-denial case
- [ ] 3.4 Implement staff step-up (`last_auth_at` check and SPA re-auth flow) with an integration test and an E2E test

## 4. CSRF and headers

- [ ] 4.1 Implement Origin and CSRF middleware for all non-GET app API routes, with tests for missing/invalid token and wrong Origin
- [ ] 4.2 Implement security headers (CSP nonce plumbing for Astro and the staff app) and verify with header tests on representative routes

## 5. Display names

- [ ] 5.1 Implement the display-name step (UTS #39 skeleton uniqueness, length rules, redirect guard) with unit tests for confusables, and E2E for a new member at 360 px
- [ ] 5.2 Implement name changes with group-limited frequency and history, plus a staff history view endpoint, with tests for the within/over-limit scenarios and a permission-denial test

## 6. Strings and seed

- [ ] 6.1 Add en/es/fr strings for login, logout, display name and errors; verify completeness
- [ ] 6.2 Seed members for every darkauth-mock profile (matching subjects), including name history for one member, and verify each profile logs in after `docker compose up --watch`
