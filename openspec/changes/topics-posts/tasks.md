# Tasks

## 1. Schema and mutations

- [x] 1.1 Migrations for topics, posts, post_revisions, polls, poll_questions, poll_choices, poll_votes, poll_vote_choices, topic_reads, forum_reads and topic_view_buffer; verify with integration tests
- [x] 1.2 Implement `startTopic`, `reply`, `editPost`, `softDelete`, `restore`, `hardDelete`, `lock`, `pin` and `move` as mutations with declared tags and transactional counters; integration tests for counter correctness under concurrent replies

## 2. Topics

- [x] 2.1 Forum topic list (pinned first, sort, pagination, prefix filter) with permission-filtered queries; integration tests including permission denial; E2E at all viewports
- [x] 2.2 Topic view (linear, paginated, post blocks referencing the `member:{id}:card` fragment, quote placeholder resolution per viewer, quoted forums' `read` bits declared from `posts.quoted_forum_ids` before lookup) with the cache variant harness applied (see-deleted, mod controls, quote source visibility); E2E at all viewports
- [x] 2.3 Moved-topic stubs, view counts (overlay and beacon recording, buffer, flush job without content tag bumps, separate views fragment) and `/topic/<id>-<slug>` routing with page/post forms and redirects; integration tests including the guest-view-counted scenario
- [x] 2.4 Author card fragment `member:{id}:card` (name, initials avatar, group, post count) tagged `member:{id}` and `ranks`, composed by reference into post blocks; tests that a post-count change rebuilds the card but not the post blocks, and that the card carries no viewer-specific data
- [x] 2.5 Permalink page computed from the viewer's visible ordering, and timestamp-based read markers; tests that a permalink lands on the right page after earlier posts are deleted, for a moderator and a member, and that unread state survives merge and split
- [x] 2.6 Protected revisions on redacting moderator edits, excluded from public history; tests for the public-history-with-redaction scenario

## 3. Posting

- [x] 3.1 Start-topic and reply flows with the editor island, prefixes, flood control and permission checks; integration tests for 403 and flood scenarios; E2E posting at 360 and 1440
- [x] 3.2 Multi-quote selection across pages, with an E2E test
- [x] 3.3 Edit with edit window, "edited by" marker, revisions, and the history/diff view with permission gating; integration tests for the window-expired and history-denied scenarios
- [x] 3.4 Moderator edit form with "Redact earlier versions in quotes" (default on), wired to snapshot redaction; integration test for the default-redaction scenario
- [x] 3.5 Soft delete, restore and hard delete UI and API, with integration tests for visibility and counts, and permission-denial tests
- [x] 3.6 Permalinks with position-based paging, with an integration test
- [x] 3.7 Register the `approved_posts` promotion criterion and evaluate promotion after each approved post; integration test that a member's 100th approved post promotes them once
- [x] 3.8 Register the topics/posts/today's-activity dashboard widget, with a permission test
- [x] 3.9 Latest-readable-post on the index, required prefixes and prefix filters on topic lists, and the move-or-delete choice when deleting a forum with topics; integration tests for each scenario in the `forums` delta

## 4. Polls

- [x] 4.1 Poll creation in the new-topic form, voting, close dates and editing rules; integration tests for each scenario; E2E voting at 360
- [x] 4.2 Poll fragments: shared choices fragment, counts only when results are public, private `GET /api/polls/:id/results` (voted, closed or moderator), and `hasVoted` in the overlay; tests that hidden counts never appear in cached or CDN HTML, permission-denial tests for the results endpoint, and a cache variant test
- [x] 4.3 Poll close as a time transition (TTL cap and minute worker bump); integration test that a cached open poll shows as closed within one minute of `closes_at`

## 5. Read tracking

- [x] 5.1 Read markers (advanced by the topic-page overlay request), unread computation in the overlay, jump to first unread, and single-row mark forum/board read; integration tests for each scenario and a test that shared HTML contains no unread state

## 6. Strings and seed

- [x] 6.1 Add en/es/fr strings for topic lists, topic view, posting, polls, history and unread; verify completeness
- [x] 6.2 Seed thousands of topics and posts across forums (realistic markdown, quotes, mentions, code, embeds, edits with history, soft-deleted posts, pinned/locked/moved topics, polls with votes, read markers for seeded members) in en/es/fr; verify after `docker compose up --watch`

## 7. Feature flag

- [ ] 7.1 Register `polls` with `defineFlag` (off in production defaults, on in the seed), gate routes with `requireFlag`, templates with `{% if flags.<key> %}` and islands with `useFlag`; tests that each surface is absent (404 or not rendered) when off, and a cache variant test for the flag toggle
