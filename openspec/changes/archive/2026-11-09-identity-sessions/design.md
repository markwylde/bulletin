# Design

## Context

ADR 0004 (identity), 0012 (PII roles and definer functions), and 0018 (origins, login flow,
sessions, CSRF) define the approach. Groups exist only minimally here (default groups seeded:
Guests, Members, Administrators, Banned). The full group system arrives in
`groups-permissions`.

## Goals / Non-Goals

**Goals:** correct, tested auth and session primitives that every later change reuses.

**Non-Goals:** group management UI; permission matrix; ban workflow (in `moderation`).

## Decisions

- **Session token**: 32 random bytes, base64url, sent in the cookie. Only its SHA-256 is
  stored. Lookup is by hash.
- **Session cache**: session rows are cached in-process for 5 s, and invalidated via
  `NOTIFY session_revoked`. Revocation is therefore effective within 5 s even if NOTIFY is
  missed (fail-closed per ADR 0006 listener health).
- **CSRF token**: an HMAC of the session ID with a server key, exposed via the overlay
  endpoint. It is validated with constant-time comparison.
- **Identity mapping**: `pii.resolve_identity(issuer, sub, email, name)` is a definer function
  callable by `user_api`/`staff_api`. It upserts `pii.identities` and returns `member_id`.
  Identity mapping is not a staff PII *read*, so it does not need the two-transaction grant
  flow. Updating email is a write and is audited.
- **Confusables**: a precomputed Unicode confusables skeleton (UTS #39) is stored as
  `core.members.name_skeleton`, with a unique index.
- **Silent re-auth** (ADR 0018): Astro middleware detects `now() > reauth_at` on top-level
  HTML navigations only (`Sec-Fetch-Mode: navigate`) and redirects to
  `/api/auth/refresh?return_to=…` on **user-api**. That creates a login challenge with a
  server-held PKCE verifier and redirects to DarkAuth with `prompt=none`. `/api/auth/callback`
  (user-api) exchanges the code and extends `reauth_at`; `login_required` revokes the session and
  returns to `return_to` as a guest. The user-api middleware allows non-navigation requests
  until `reauth_at + 2h`, then returns `401 {code:"reauth_required"}`. A shared client fetch
  wrapper handles that code: it stashes editor content (ADR 0014 local draft store) and shows
  the continue prompt.
- **`return_to` validation**: only same-origin relative paths are accepted (no open redirect).
- **Staff step-up**: `core.sessions.last_auth_at`. Sensitive endpoints check it is within
  15 minutes; if not, they return 401 `step_up_required`, and the SPA starts a challenge with
  `max_age=0`. The returned ID token's `auth_time` must be within 60 s of the challenge before
  `last_auth_at` is updated (ADR 0018).
- **Session IDs**: `bigint` identity primary key plus a unique `token_hash`; the raw token is
  only in the cookie.
- **Rotation**: group changes set `rotate_pending`; user-api issues the new token on the next
  response and honours the old one for 60 s.
- **CSRF token endpoint**: `GET /api/auth/session` on user-api and staff-api returns the
  session's CSRF token, display name and flags the client needs; the overlay repeats it later.
- **Pages**: this change ships no themed user-app pages. The login button and the
  `/auth/callback` transit route are script-only (a translated "signing you in" message and
  no content), so they need no template or cache contract. The display-name step and the
  account page are built on the template stack in `rendering-and-caching`.
- **Service members**: `core.members.is_service` (no identity, cannot log in, excluded from
  member lists and leaderboards) is created here, so later changes (plugin service principals,
  API key principals, multi-mod auto-replies) share one primitive.
- **Test seams**: re-auth and step-up are tested against test-only endpoints
  (`/api/test/protected`, `/api/test/sensitive`) enabled outside production, because drafts,
  replies and the IP log arrive in later changes. The name-change limit is a constant until
  `groups-permissions` replaces it with a group setting.

## Risks / Trade-offs

- [DarkAuth outage blocks all logins] → existing sessions keep working until `reauth_at`;
  re-auth failure due to a network error (rather than a denial) extends `reauth_at` by 1 h,
  up to 3 times.
- [Confusable normalisation rejects legitimate names] → staff can override with a reason, which is logged.

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| DarkAuth issuer/sub, email (`pii.identities`) | Restricted | login, account email | life of account | `pii.resolve_identity` (user_api, staff_api); no staff read path | email included | deleted |
| Session IP and user agent (`pii.session_meta`) | Restricted | security, session list | 30 days; revoked sessions 7 days | `pii.record_session_meta` write-only; the member sees their own sessions via a definer read | included | deleted |
| Login IPs (`pii.ip_log`) | Restricted | abuse prevention | 90 days | `pii.record_login_ip` write-only; reads in `moderation` | included | deleted |
| Display name, name skeleton, preferences (`core.members`) | Personal content | public identity | life of account | `can()`; public | included | anonymised to "Deleted member #n" |
| Session token hash, `last_auth_at` (`core.sessions`) | Security record | authentication | until expiry + 7 days | the member's own sessions | not exported (secret) | deleted |

## Feature flags (ADR 0010)

None: login and sessions are core, exempt under ADR 0010.
