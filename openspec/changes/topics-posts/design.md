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
- **Positions**: `position` is a stable insertion order assigned under `SELECT … FOR UPDATE`
  on the topic. It orders posts but is **not** a page number: hidden and deleted posts, and the
  viewer's see-unapproved/see-deleted bits, change which posts are visible. A permalink's page
  is computed per variant as `count(visible posts before it) / perPage` using the index
  `(topic_id, visibility, position)`, which is cheap at forum page sizes.
- **Counters**: updated in the posting transaction (forum, topic, member). The forum last-post
  info stores only the latest *visible* post. Unapproved and deleted posts never update
  public last-post. Moderators see their extra rows through dep-declared queries.
- **Fragments**:
  - The topic page is composed of a header fragment plus post-block fragments, keyed by
    `post:{id}@version` and the viewer's deps (mod controls, see-deleted).
  - The page fragment is tagged with `topic:{id}:pages`.
  - **Quoted forums**: `posts.quoted_forum_ids` (from the content pipeline) lets the route
    load the distinct quoted forum IDs for the page with one indexed query and declare their
    effective `read` bits in `deps` before the cache lookup (ADR 0005).
  - **Author card by reference**: a post block never embeds author details. It contains a
    reference to the fragment `member:{id}:card` (display name, avatar, group, rank and pips,
    custom title, featured badges, reputation label, post count), which the page composer
    resolves at render time. The card is tagged `member:{id}` and `ranks`, so a rank, title,
    badge or post-count change rebuilds one small card per member, not every post block they
    wrote. This change builds the card with name, initials avatar, group and post count; later
    changes add fields to its view model (`attachments-avatars` adds the uploaded avatar).
  - Reply mutation tags: `topic:{id}`, `topic:{id}:pages`, `forum:{forum}` and ancestors, the
    board index, and `member:{author}`.
- **View counts** (ADR 0006 read-path writes): recorded by the member overlay request
  (`ctx=topic:<id>`) and by the guest beacon (`POST /api/beacon`). Both insert into an UNLOGGED
  table `topic_view_buffer(topic_id, viewer_key, bucket)` with a unique constraint for the
  30-minute dedupe. A worker flushes to `topics.view_count` every minute **without bumping
  `topic:{id}`**. The count is rendered in a separate fragment tagged `topic:{id}:views` with
  a 60 s TTL.
- **Read markers**: `topic_reads(member_id, topic_id, last_read_at, last_read_post_id)` and
  `forum_reads(member_id, forum_id, marked_at)`, plus `members.board_marked_at`. "Mark forum
  read" is a single upsert into `forum_reads`. The overlay request for a topic page advances
  `last_read_at` to the `created_at` of the last post on that page (timestamps survive merge,
  split and renumbering, unlike positions), and computes unread state for the
  topic IDs on list pages in one query.
- **URLs**: `/topic/<id>-<slug>[/page/<n>|/post/<postId>]` per ADR 0001. Post permalinks compute the page from the viewer's visible ordering (see Positions).
- **Protected revisions**: a redacting moderator edit marks all earlier `post_revisions` rows
  `protected = true`. Public history (board setting) never returns protected rows; only
  moderators with view-history see them.
- **Moderator edit redaction**: the edit form passes `redact` (default true when the editor
  is not the author and is acting as moderator) to the content pipeline's snapshot redaction.
- **Polls**: `polls(…, closes_at)`, `poll_questions`, `poll_choices`,
  `poll_votes(poll_id, member_id, created_at)` unique per poll, and
  `poll_vote_choices(poll_id, member_id, question_id, choice_id)`, which records the chosen
  options for tallies, public voter lists and erasure recounts. Closing by date is a time
  transition: the poll fragment's TTL is capped at `closes_at`, and the minute transition
  worker bumps `poll:{id}` (ADR 0006).
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
