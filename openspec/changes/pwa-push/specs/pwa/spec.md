# Spec Delta

## Purpose

Lets members install the forum like an app and keeps it responsive on poor connections,
without storing forum content on devices.

## ADDED Requirements

### Requirement: Installable app
The user app SHALL provide a web app manifest with the board name, icons and colours from the active theme, so supporting browsers offer installation.

#### Scenario: Install prompt
- **WHEN** a member visits on a supporting mobile browser
- **THEN** the browser offers to install the app, and the installed app opens to the board index

### Requirement: Offline shell without content
The service worker SHALL cache only the app shell, static assets and an offline page. Pages, API responses, overlay data and attachments SHALL always come from the network.

#### Scenario: Offline navigation
- **WHEN** a member opens the installed app with no connection
- **THEN** they see the shell with a translated offline message, and no forum content

#### Scenario: No content cached
- **WHEN** the service worker caches are inspected after browsing topics
- **THEN** they contain no topic, post, profile or conversation responses

### Requirement: Unsent drafts survive offline
If a member submits a post or message while offline, the draft SHALL be kept on the device and the member SHALL be offered to send it when the connection returns.

#### Scenario: Reconnect
- **WHEN** a member submitted a reply offline and the connection returns
- **THEN** they are prompted to send it, and it posts after confirmation

### Requirement: Local data cleared on sign-out
Device-stored data (drafts, caches beyond static assets) SHALL be cleared on logout, on switching account, and when the session is revoked.

#### Scenario: Revoked session
- **WHEN** staff revoke a member's sessions while the app is open
- **THEN** the app clears local drafts and shows the logged-out state

### Requirement: Fresh assets after deploy
After a deployment, the app SHALL use new static assets on the next navigation, without serving stale scripts against a newer server.

#### Scenario: New version
- **WHEN** a new version is deployed while a member has the app open
- **THEN** their next navigation loads the new assets
