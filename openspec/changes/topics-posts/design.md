# Design

## Context

Builds on changes 6 (permissions), 8 (rendering and caching) and 9 (content). The cache
variant harness from change 8 must be applied to the topic and forum routes.

## Goals / Non-Goals

**Goals:** correct counters under concurrency; fragment caching per post block and page.

**Non-Goals:** reactions (change 13); attachments (change 11); moderation tools beyond
delete/restore/lock/pin/move (change 16).

## Decisions

- **Schema**:
  - `topics(id, forum_id, title, slug, prefix_id, starter_id, state flags, reply_count,
    view_count, first_post_id, last_post_id, last_post_at, moved_to, stub_expires_at)`
  - `posts(id, topic_id, author_id, body_md, body_html, body_text, render_version,
    sanitiser_version, visibility enum(visible, unapproved, soft_deleted), position, created_at,
    edited_at, edited_by)`
  - `post_revisions`
- **Positions**: `position` is assigned under `SELECT … FOR UPDATE` on the topic, giving
  O(1) page lookup for permalinks.
- **Counters**: updated in the posting transaction (forum, topic, member). The forum last-post
  info stores only the latest *visible* post. Unapproved and deleted posts never update
  public last-post. Moderators see their extra rows through dep-declared queries.
- **Fragments**:
  - The topic page is composed of a header fragment plus post-block fragments, keyed by
    `post:{id}@version` and the viewer's deps (mod controls, see-deleted).
  - The page fragment is tagged with `topic:{id}:pages`.
  - Reply mutation tags: `topic:{id}`, `topic:{id}:pages`, `forum:{forum}` and ancestors, the
    board index, and `member:{author}`.
- **View counts** (ADR 0006 read-path writes): recorded by the member overlay request
  (`ctx=topic:<id>`) and by the guest beacon (`POST /api/beacon`). Both insert into an UNLOGGED
  table `topic_view_buffer(topic_id, viewer_key, bucket)` with a unique constraint for the
  30-minute dedupe. A worker flushes to `topics.view_count` every minute **without bumping
  `topic:{id}`**. The count is rendered in a separate fragment tagged `topic:{id}:views` with
  a 60 s TTL.
- **Read markers**: `topic_reads(member_id, topic_id, last_read_post_position)` and
  `forum_reads(member_id, forum_id, marked_at)`, plus `members.board_marked_at`. "Mark forum
  read" is a single upsert into `forum_reads`. The overlay request for a topic page advances
  `last_read_post_position` to the last post on that page, and computes unread state for the
  topic IDs on list pages in one query.
- **URLs**: `/topic/<id>-<slug>[/page/<n>|/post/<postId>]` per ADR 0001. Post permalinks use
  `position` to compute the page.
- **Moderator edit redaction**: the edit form passes `redact` (default true when the editor
  is not the author and is acting as moderator) to the content pipeline's snapshot redaction.
- **Polls**: `polls`, `poll_questions`, `poll_choices` and `poll_votes(member_id, poll_id)`
  unique per poll. Results are a separate fragment, so voting doesn't invalidate the whole page.

## Risks / Trade-offs

- [Hot topic lock contention on `position`] → the lock is held briefly; acceptable at forum
  scale, and measured in the load test (ADR 0020).
- [Overlay query cost on big pages] → bounded by page size (≤ 50 topics).
