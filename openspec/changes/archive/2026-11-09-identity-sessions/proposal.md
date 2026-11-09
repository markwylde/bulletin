# Proposal

## Why

Members must log in through DarkAuth (ADR 0004). Bulletin then needs its own sessions,
member records, display names and CSRF protection (ADR 0018) before any member-facing or
staff feature can exist.

## What Changes

- Server-bound login challenge, DarkAuth Authorization Code + PKCE flow, and session creation for the user and staff origins.
- `core.sessions`, `core.session_grants`, `core.login_challenges`; `pii.identities`, `pii.session_meta`.
- Member creation on first login, with display name choice, uniqueness and change history.
- Session lifetimes, re-auth, rotation, logout, and staff revocation of a member's sessions.
- CSRF tokens plus Origin checks on all state-changing app API requests.
- Security headers on all responses.
- Bootstrap admins via env.

## Capabilities

### New Capabilities
- `auth-sessions`: login, sessions, re-authentication, logout, CSRF and security headers.
- `member-identity`: member records, identity mapping, display names and name history.

### Modified Capabilities
- None.

## Impact

- user-api, staff-api, user-app, staff-app, `packages/domain`, migrations, darkauth-mock config.
- Adds the first `pii` tables and definer functions (ADR 0012).
