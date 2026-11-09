# Spec Delta

## Purpose

Lets people sign in to the user and staff apps with DarkAuth, and keeps their Bulletin
sessions secure: bound to the browser, expiring, revocable, and protected against CSRF.

## ADDED Requirements

### Requirement: DarkAuth login with server-bound challenge
Login SHALL begin with a server-issued single-use challenge bound to the browser by a host-only cookie, followed by Authorization Code + PKCE against DarkAuth. The ID token's nonce SHALL equal the challenge nonce.

#### Scenario: Successful login
- **WHEN** a guest clicks "Log in", authenticates at DarkAuth, and returns
- **THEN** a new Bulletin session is created and the guest is shown as logged in

#### Scenario: Replayed token
- **WHEN** an ID token that was already exchanged is posted again with the same challenge
- **THEN** the request is rejected with 401 and no session is created

#### Scenario: Login CSRF
- **WHEN** a cross-site page posts an attacker's valid ID token to the session endpoint in the victim's browser
- **THEN** the request is rejected because the challenge cookie and nonce do not match

### Requirement: Token acceptance boundaries
DarkAuth tokens SHALL be accepted only by the session-creation endpoint. App APIs SHALL accept only session cookies. Requests with other credential types SHALL be rejected.

#### Scenario: Bearer token on app API
- **WHEN** a request to an app API endpoint carries a DarkAuth bearer token and no session cookie
- **THEN** it is treated as a guest request

### Requirement: Separate user and staff sessions
User and staff sessions SHALL be separate, host-only cookies on their own origins. A staff session SHALL NOT be usable on the user origin or the reverse.

#### Scenario: Staff cookie on user origin
- **WHEN** a staff session cookie value is sent to the user API
- **THEN** it is not recognised

### Requirement: Session lifetimes
User sessions SHALL expire after 30 days idle or 90 days absolute, and SHALL require a silent DarkAuth re-auth every 24 hours. Staff sessions SHALL expire after 2 hours idle or 12 hours absolute.

#### Scenario: Silent re-auth fails
- **WHEN** a user session passes its 24-hour re-auth point, the member navigates to a page, and the DarkAuth account has been disabled
- **THEN** the top-level redirect re-auth fails, and the member lands on the requested page as a guest with a "please log in again" notice

### Requirement: Silent re-auth by top-level redirect
Re-authentication after the 24-hour point SHALL happen on the next top-level page navigation, by redirecting to DarkAuth with `prompt=none` and returning to the requested URL. It SHALL NOT rely on hidden frames or third-party cookies.

#### Scenario: Successful silent re-auth
- **WHEN** a member with a still-valid DarkAuth session navigates after the re-auth point
- **THEN** they briefly redirect through DarkAuth and land on the requested page, still logged in

### Requirement: Background requests during re-auth
Background requests (overlay, live stream, draft autosave, mutations) SHALL keep working for 2 hours after the re-auth point. After that they SHALL return 401 with code `reauth_required`, and the client SHALL preserve unsaved editor content and offer to continue.

#### Scenario: Within grace
- **WHEN** a member's draft autosave runs 30 minutes after the re-auth point without any navigation
- **THEN** the draft is saved normally

#### Scenario: After grace
- **WHEN** a member's client sends a mutation 3 hours after the re-auth point without any navigation
- **THEN** the API returns `reauth_required`, the client keeps the unsent request body locally, and after the member continues through re-auth the request is offered for resubmission

#### Scenario: Staff idle timeout
- **WHEN** a staff session is idle for more than 2 hours
- **THEN** the next staff request requires logging in again

### Requirement: Step-up for sensitive staff actions
Changing permissions, managing plugins or viewing PII SHALL require a DarkAuth authentication within the last 15 minutes.

#### Scenario: Stale staff auth
- **WHEN** a staff member last authenticated 40 minutes ago and calls a sensitive endpoint
- **THEN** they are sent to re-authenticate, then returned to where they were

#### Scenario: Old IdP session does not count
- **WHEN** a staff member completes step-up but DarkAuth returns an `auth_time` from two hours ago
- **THEN** `last_auth_at` is not updated and the sensitive endpoint is still refused

### Requirement: Session rotation
The session identifier SHALL change on login and whenever the member's group membership changes.

#### Scenario: Promotion rotates session
- **WHEN** a member is promoted to a new group during an active session
- **THEN** their next API response sets a new session cookie, and 60 seconds later the old identifier no longer works

### Requirement: Logout and revocation
Logout SHALL revoke the session server-side, clear the cookie, and instruct the client to clear local data. Staff with the right permission SHALL be able to revoke all of a member's sessions.

#### Scenario: Revoke all sessions
- **WHEN** an admin revokes all sessions of a member
- **THEN** that member's next request on any device is treated as a guest

### Requirement: CSRF protection
Every non-GET app API request SHALL require a matching `Origin` header and a valid per-session CSRF token, except the named bootstrap endpoints in ADR 0018 (login challenge and session, guest beacon, overlay, signed unsubscribe), which SHALL use their documented alternative checks. GET requests SHALL NOT change state.

#### Scenario: Missing CSRF token
- **WHEN** a logged-in member's browser sends a POST without the CSRF token header
- **THEN** the API responds 403 and nothing changes

#### Scenario: Cross-site overlay call
- **WHEN** a third-party page makes the browser POST to the overlay endpoint without the required header
- **THEN** the request is refused before any visit is recorded

### Requirement: Security headers
All responses SHALL include a nonce-based Content Security Policy, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: strict-origin-when-cross-origin`. App origins SHALL set `frame-ancestors 'none'`, and production SHALL set HSTS.

#### Scenario: Headers present
- **WHEN** any user-app page is requested
- **THEN** the response carries the listed headers
