# Tasks

## 1. Schema and mutations

- [ ] 1.1 Migrations for topics, posts, post_revisions, polls, poll_questions, poll_choices, poll_votes, topic_reads, forum_reads and topic_view_buffer; verify with integration tests
- [ ] 1.2 Implement `startTopic`, `reply`, `editPost`, `softDelete`, `restore`, `hardDelete`, `lock`, `pin` and `move` as mutations with declared tags and transactional counters; integration tests for counter correctness under concurrent replies

## 2. Topics

- [ ] 2.1 Forum topic list (pinned first, sort, pagination, prefix filter) with permission-filtered queries; integration tests including permission denial; E2E at all viewports
- [ ] 2.2 Topic view (linear, paginated, post blocks with author info, quote placeholder resolution per viewer) with the cache variant harness applied (see-deleted, mod controls, quote source visibility); E2E at all viewports
- [ ] 2.3 Moved-topic stubs, view counts (overlay and beacon recording, buffer, flush job without content tag bumps, separate views fragment) and `/topic/<id>-<slug>` routing with page/post forms and redirects; integration tests including the guest-view-counted scenario

## 3. Posting

- [ ] 3.1 Start-topic and reply flows with the editor island, prefixes, flood control and permission checks; integration tests for 403 and flood scenarios; E2E posting at 360 and 1440
- [ ] 3.2 Multi-quote selection across pages, with an E2E test
- [ ] 3.3 Edit with edit window, "edited by" marker, revisions, and the history/diff view with permission gating; integration tests for the window-expired and history-denied scenarios
- [ ] 3.6 Moderator edit form with "Redact earlier versions in quotes" (default on), wired to snapshot redaction; integration test for the default-redaction scenario
- [ ] 3.4 Soft delete, restore and hard delete UI and API, with integration tests for visibility and counts, and permission-denial tests
- [ ] 3.5 Permalinks with position-based paging, with an integration test

## 4. Polls

- [ ] 4.1 Poll creation in the new-topic form, voting, close dates, results visibility and editing rules; integration tests for each scenario; E2E voting at 360

## 5. Read tracking

- [ ] 5.1 Read markers (advanced by the topic-page overlay request), unread computation in the overlay, jump to first unread, and single-row mark forum/board read; integration tests for each scenario and a test that shared HTML contains no unread state

## 6. Strings and seed

- [ ] 6.1 Add en/es/fr strings for topic lists, topic view, posting, polls, history and unread; verify completeness
- [ ] 6.2 Seed thousands of topics and posts across forums (realistic markdown, quotes, mentions, code, embeds, edits with history, soft-deleted posts, pinned/locked/moved topics, polls with votes, read markers for seeded members) in en/es/fr; verify after `docker compose up --watch`
