# 0018 — Authentication, sessions and origin topology

**Status:** Accepted

## Context
Different ports do not isolate cookies. Login, session, CSRF and token-acceptance rules must
be explicit.

## Decision
### Origins (behind one reverse proxy, `proxy` service: Caddy)
| Origin (local) | Production example | Serves |
|---|---|---|
| `http://bulletin.localhost:8080` | `forum.example.com` | user-app; `/api/*` → user-api |
| `http://staff.bulletin.localhost:8080` | `staff.forum.example.com` | staff-app; `/api/*` → staff-api |
| `http://files.bulletin.localhost:8080` | `files.forum-usercontent.com` | attachments/avatars (ADR 0019) |
| `http://plugins.bulletin.localhost:8080` | `plugins.forum-usercontent.com` | plugin iframe apps (ADR 0009) |
| `http://auth.bulletin.localhost:8080` | DarkAuth issuer | darkauth-mock |

- `*.localhost` resolves to loopback in browsers, so no hosts-file edits are needed.
- **Production user-content origins are on a separate registrable domain**, so they share no
  cookies and no same-site status with the forum.
- Each app's API is **same-origin** with its app, so app APIs need no CORS.
- Cookies are **host-only** (no `Domain` attribute) and use the `__Host-` prefix in production.
  Names: `__Host-bl_session` (user), `__Host-bl_staff` (staff). User and staff sessions are
  separate: a staff session is never created from, or valid on, the user origin.

### Login flow (server-bound challenge)
1. `POST /api/auth/challenge` (Origin-checked) creates a row in `core.login_challenges(id,
   state, nonce, expires_at = +10 min, used_at)` and sets host-only cookie
   `__Host-bl_login=<id>` (`HttpOnly; SameSite=Lax`). It returns `state` and `nonce`.
2. The browser runs Authorization Code + PKCE via `@darkauth/client` with that `state` and
   `nonce`. The PKCE verifier stays client-side, and the client checks `state` on return.
3. The browser posts the ID token to `POST /api/auth/session`. The API requires:
   - a matching `Origin`,
   - the `__Host-bl_login` cookie referencing an unexpired, **unused** challenge,
   - the token's `nonce` to equal the challenge's nonce,
   - valid `iss`, `aud` (client-specific), `exp` and signature via JWKS.

   It marks the challenge used (single-use, in the same transaction as session creation),
   maps `(issuer, sub)` to a member (ADR 0004), and **creates a new session** (new ID; the
   login cookie is cleared).
- This endpoint is exempt from the session CSRF token because no session exists yet. The
  browser-bound challenge cookie plus nonce replaces it, which prevents login CSRF and token replay.
- **DarkAuth tokens are accepted only at `/api/auth/session`.** App APIs accept only session
  cookies, and `/api/v1` accepts only API keys (ADR 0016).

### Sessions
- `core.sessions(id = 256-bit random, stored as hash; member_id; kind user|staff; created_at;
  last_seen_at; reauth_at; revoked_at)`. IP and user agent go in `pii.session_meta`.
- User sessions: 30-day idle timeout, 90-day absolute, and `reauth_at` = 24 h. This is how a
  disabled DarkAuth account is noticed.
- **Silent re-auth is a top-level redirect, never an iframe**, because third-party cookies
  are blocked and DarkAuth may be cross-site.
  - The first **top-level page navigation** after `reauth_at` redirects to `/auth/refresh`.
    That creates a login challenge and redirects to DarkAuth with `prompt=none` and a `return_to`.
  - On success, the session's `reauth_at` is extended and the browser returns to the original URL.
  - On `login_required` (or any denial), the session is revoked and the member lands on the
    original URL as a guest, with a "please log in again" notice.
- **Background requests** (overlay, SSE, draft autosave, mutations) are never redirected:
  - Within a **grace window of 2 hours** after `reauth_at`, they continue to work normally.
  - After the grace window, they return `401 { code: "reauth_required" }`. The client keeps
    unsaved editor content in local storage (ADR 0014), shows a "continue" prompt that does a
    top-level navigation to `/auth/refresh?return_to=<current>`, and resubmits the draft after return.
  - SSE streams close with a `reauth_required` event at the same point.
- Staff sessions: 2 h idle, 12 h absolute, and re-auth required for sensitive ACP actions
  (permissions, plugins, PII views) if the last auth was more than 15 minutes ago.
- **Rotation**: the session ID rotates on login and on any group change affecting the member.
- **Logout** revokes the row, clears the cookie, and tells the client to clear offline caches
  (ADR 0014). Staff can revoke all of a member's sessions.
- **Session grants** (`core.session_grants`): unlocked password forums, bound to the session
  and dropped with it.
- Bans and suspensions take effect on the next request: the permission snapshot is
  revalidated per ADR 0006.

### CSRF and headers
- Cookies are `SameSite=Lax; HttpOnly; Secure` (Secure in production).
- All non-GET requests to app APIs require a **matching `Origin` header** plus a per-session
  **CSRF token** sent in `X-Bulletin-CSRF`. The token is exposed via the overlay endpoint.
- GET requests are never state-changing.
- Headers on every response: strict CSP with nonces (ADR 0008), `frame-ancestors 'none'` on
  app origins, HSTS in production, `X-Content-Type-Options: nosniff`, and
  `Referrer-Policy: strict-origin-when-cross-origin`.

## Consequences
- Local URLs change from per-port to hostnames on one port; ADR 0002 points here.
