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
- **Silent re-auth**: on a navigation after `reauth_at`, the server responds with a redirect
  to `/auth/refresh`, which runs `prompt=none`. On error it logs the member out.
- **Staff step-up**: `core.sessions.last_auth_at`. Sensitive endpoints check it is within
  15 minutes; if not, they return 401 `step_up_required`, and the SPA starts the flow.

## Risks / Trade-offs

- [DarkAuth outage blocks all logins] → existing sessions keep working until `reauth_at`;
  re-auth failure due to a network error (rather than a denial) extends `reauth_at` by 1 h,
  up to 3 times.
- [Confusable normalisation rejects legitimate names] → staff can override with a reason, which is logged.
