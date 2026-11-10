# Design

## Context

ADR 0007 fixes the pipeline shape. Attachments (change `attachments-avatars`) plug in as an extension later.
Plugins add extensions in change `plugin-platform`.

## Goals / Non-Goals

**Goals:** a single pipeline with profiles; an extension API; an editor that is lossless by test.

**Non-Goals:** collaborative editing; BBCode import.

## Decisions

- **Pipeline**:
  - `unified` with `remark-parse`, `remark-gfm`, then our remark extensions (mention, emoticon,
    quote-ref, spoiler, embed) → `remark-rehype` → `rehype-highlight` → `rehype-sanitize`
    (profile schema).
  - Our serializer produces `body_html`, plus a separate HAST → text walker for `body_text`
    that skips quote nodes.
  - Quote placeholders are emitted as `<bl-quote data-source="…" data-snapshot="…"></bl-quote>`.
    They are resolved at fragment build by the view-model layer (topic view in change `topics-posts`).
- **Quote snapshots**: `quote_snapshots(id, source_post_id, source_author_id, body_md,
  body_html, render_version, sanitiser_version, created_at, redacted_at)`. Snapshots are
  re-rendered by the same job and on-read rules as posts, so sanitiser upgrades and
  replace-word changes reach them (ADR 0007). The pipeline also writes
  `quoted_forum_ids bigint[]` on the quoting post (ADR 0005). The quote extension validates the source context (forum post → forum post;
  message → same conversation) and `can(read)` for the author. A moderator edit with redaction
  sets `redacted_at` on all snapshots of the post and bumps `post:{id}:snapshots`, which every
  quoting fragment declares as a tag.
- **Replace-word transform**: a rehype plugin applies the current replace list to text nodes
  (and the text walker for `body_text`). It never touches `body_md`. The filter list version
  is folded into `render_version`, so changes trigger the re-render job, and stale rows are
  transformed on read until re-rendered.
- **Versions**: `render_version` (pipeline) and `sanitiser_version` (rules), stored per row. A
  constant in code marks the current values. Reads check the row's `sanitiser_version` and,
  if it is stale, run `rehype-sanitize` on the stored HTML before caching (cheap: no markdown parse).
- **Re-render job**: batches of 500 rows ordered by ID, resumable via a cursor in
  `core.job_cursors`.
- **Editor**: Milkdown with commonmark + gfm presets and custom nodes for mention, emoticon,
  quote, spoiler and embed. Unknown syntax maps to a `raw_markdown` node that round-trips
  verbatim. A round-trip corpus test runs in `bun test` via Milkdown's headless serializer.
- **Drafts**: `core.drafts(member_id, context_key, body_md, updated_at)` with a unique
  `(member_id, context_key)`. The island debounces saves at 2 s. Drafts are delivered via the
  overlay (personal).
- **Unfurls**:
  - A worker fetches through `safeFetch` (ADR 0016: pinned resolved IP, blocked ranges,
    each redirect re-checked, max 3), caps responses at 1 MB and 5 s, and parses OpenGraph/oEmbed.
  - Images are fetched and stored via storage (change `attachments-avatars` provides the proxy; until then, cards
    are text-only).
  - Results go to `core.unfurls(url_hash, data, fetched_at)`, refreshed after 7 days.
- **Write-pipeline hook points**: `beforeSave(content, ctx)` stages run in this order:
  plugin transform filters (`plugin-platform`) first, then the core checks (bad words, link
  limits, spam, filled by `moderation`), then plugin veto filters, then parse and sanitise. A
  plugin can therefore never add content after the core checks have passed.

## Risks / Trade-offs

- [Milkdown fidelity gaps] → the corpus test gates releases; the source mode is always available.
- [Re-sanitise on read adds latency during an upgrade] → it applies only on cache misses, and only to stale rows.

## Feature flags (ADR 0010)

`unfurls` (link previews) and `mentions`. Markdown posting itself is core and not flagged.

Gating: server routes use `requireFlag(key)` (404 when off), templates use `{% if flags.<key> %}`, and islands use `useFlag(key)`. Flags marked `affectsRender` are part of the cache variant (ADR 0006, 0010).

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| Drafts (`core.drafts`) | Personal content | unsent work | 30 days after last edit | the author only, via the overlay | included | deleted |
| Quote snapshots (`quote_snapshots`) | Personal content (of the quoted author) | stable quotes | life of the quoting post | `can(read)` on the source at render; redaction per ADR 0007 | included in the quoted author's export | the quoted author's erasure redacts their snapshots |
| Mentions (rendered links and notification triggers) | Personal content | addressing members | life of the post | as the post | included with posts | rendered as "Deleted member" after erasure |
| Unfurl cache (URL metadata) | Derived (third-party public data) | link previews | 7 days | as the post | excluded | ages out |
