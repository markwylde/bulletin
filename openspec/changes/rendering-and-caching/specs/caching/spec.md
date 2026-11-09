# Spec Delta

## Purpose

Makes pages fast by sharing rendered output between viewers who can see exactly the same
thing. It guarantees that cached output never shows content a viewer cannot see, beyond the
stated revocation windows.

## ADDED Requirements

### Requirement: Variant by visibility, not identity
Shared rendered output SHALL be cached per combination of route, parameters, the view's declared permission bits, theme version, plugin generation, locale, colour scheme and evaluated render flags. It SHALL NOT include any per-member data.

#### Scenario: Same bits share
- **WHEN** two members in different groups have identical permission bits for a topic
- **THEN** the second request is served from the cache entry created by the first

#### Scenario: Different bits separate
- **WHEN** a moderator with see-deleted and a member without it view the same topic
- **THEN** they receive different cache entries, and the member's entry contains no deleted posts

### Requirement: Personal data via overlay
Per-member information (unread markers, notification and message counts, ignored members, own reactions, drafts, CSRF token) SHALL be delivered only by a private overlay request after the page loads, never in shared output.

#### Scenario: Unread markers
- **WHEN** a member views a forum with unread topics
- **THEN** the shared HTML has no unread markers, and the overlay adds them

### Requirement: Invalidation on change
Every write SHALL invalidate all cached output that depends on what it changed, in the same transaction as the write.

#### Scenario: New reply
- **WHEN** a reply is posted
- **THEN** the next request for that topic's last page, the forum list and the board index reflects the reply

### Requirement: Member revocation window
When a member loses access to content, cached output SHALL stop being served to them within 1 second.

#### Scenario: Access removed
- **WHEN** a member's access to a forum is revoked while its pages are cached
- **THEN** within 1 second they receive a denial instead of cached content

### Requirement: Fail closed on lost invalidation
If a process cannot confirm it is receiving invalidations (listener disconnected or heartbeat late by more than 5 seconds), it SHALL bypass its in-process cache until it recovers.

#### Scenario: Listener drop
- **WHEN** the listener connection drops
- **THEN** subsequent responses are marked `BYPASS` until the listener reconnects and reloads versions

### Requirement: CDN caches guest pages only
Only responses to requests without a session or forum unlock, on routes marked CDN-cacheable, SHALL be publicly cacheable. They SHALL vary only by the guest preference cookie. All other responses SHALL be private.

#### Scenario: Member response
- **WHEN** a logged-in member requests the board index
- **THEN** the response is `Cache-Control: private`

#### Scenario: Guest preference
- **WHEN** two guests request a page with different `bp` locales
- **THEN** the CDN serves each its locale variant

### Requirement: Guest revocation window
When content stops being visible to guests, it SHALL be purged from the CDN immediately on a best-effort basis, and SHALL NOT be served to guests for more than 30 seconds after the change.

#### Scenario: Forum made private
- **WHEN** a public forum is made members-only
- **THEN** guests stop receiving its pages within 30 seconds, and the staff app states this window next to the setting

### Requirement: Conditional requests respect permissions
ETags SHALL be derived from the variant and its content versions, so a 304 response is never issued across a permission or content change.

#### Scenario: 304 after revocation
- **WHEN** a member whose access was just revoked revalidates with a previous ETag
- **THEN** they receive a denial, not 304

### Requirement: Performance targets
On the seeded dataset with warm caches, the p95 time to first byte SHALL be under 30 ms for cached guest pages, under 80 ms for member pages, and under 200 ms for cold renders.

#### Scenario: Benchmark
- **WHEN** the performance test runs against the seeded stack
- **THEN** it passes the three latency thresholds

### Requirement: Cache diagnostics in development
In development, responses SHALL include `X-Cache` (`HIT`, `MISS`, `STALE` or `BYPASS`) and `X-Cache-Key` headers.

#### Scenario: Diagnostic headers
- **WHEN** a developer loads a forum page twice
- **THEN** the second response has `X-Cache: HIT`
