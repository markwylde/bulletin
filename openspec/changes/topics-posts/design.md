# Design

## Context

Builds on `groups-permissions`, `rendering-and-caching` and `content-pipeline`. The cache
variant harness from `rendering-and-caching` must be applied to the topic and forum routes.

## Goals / Non-Goals

**Goals:** correct counters under concurrency; fragment caching per post block and page.

**Non-Goals:** reactions (change `reactions-reputation`); attachments (change `attachments-avatars`); moderation tools beyond
delete/restore/lock/pin/move (change `moderation`).

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
  - **Author card by reference**: a post block never embeds author details. It contains a
    reference to the fragment `member:{id}:card` (display name, avatar, group, rank and pips,
    custom title, featured badges, reputation label, post count), which the page composer
    resolves at render time. The card is tagged `member:{id}` and `ranks`, so a rank, title,
    badge or post-count change rebuilds one small card per member, not every post block they
    wrote. This change builds the card with name, avatar, group and post count; later changes
    add fields to its view model.
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
  unique per poll.
  - **Shared fragment** (`poll:{id}`, cacheable): questions and choices. When results are
    visible to everyone (open results, or the poll is closed), it also carries the counts and
    is tagged `poll:{id}:results`, which a vote bumps (coalesced to at most one bump per 5 s).
  - **Hidden results**: the shared fragment carries choices only, never counts. Results come
    from `GET /api/polls/:id/results` on user-api (`private, no-store`), which checks per
    request that the viewer has voted, the poll is closed, or they moderate the forum.
  - **Overlay**: `hasVoted` for polls on the page comes from the personal overlay, so the
    island shows the ballot or fetches results without varying the shared HTML.

## Risks / Trade-offs

- [Hot topic lock contention on `position`] → the lock is held briefly; acceptable at forum
  scale, and measured in the load test (ADR 0020).
- [Overlay query cost on big pages] → bounded by page size (≤ 50 topics).

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| Posts, topics, revisions (`core.posts`, `post_revisions`) | Personal content | the forum itself | indefinite; revisions per board setting | `can()` on the forum | included | admin choice: anonymise or delete; revisions deleted |
| Drafts | Personal content | unsent work | 30 days after last edit | author only | included | deleted |
| Poll votes (`poll_votes`) | Personal content | poll tallies; voter lists only if the poll is public | life of poll | tallies per poll visibility; voter list only when public | included | deleted, tallies recomputed |
| Read markers, view-buffer guest keys | Derived | unread state, view counts | read markers life of account; buffer flushed each minute | the member only | excluded (derived) | deleted |

## Feature flags (ADR 0010)

`polls`. Topics, replies, editing and read tracking are core and not flagged.

Gating: server routes use `requireFlag(key)` (404 when off), templates use `{% if flags.<key> %}`, and islands use `useFlag(key)`. Flags marked `affectsRender` are part of the cache variant (ADR 0006, 0010).
