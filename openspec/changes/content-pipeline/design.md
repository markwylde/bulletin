# Design

## Context

ADR 0007 fixes the pipeline shape. Attachments (change 11) plug in as an extension later.
Plugins add extensions in change 19.

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
    They are resolved at fragment build by the view-model layer (topic view in change 10).
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
  - A worker resolves DNS, rejects private, link-local, loopback and CGNAT ranges (re-checked
    on each redirect, max 3), caps responses at 1 MB and 5 s, and parses OpenGraph/oEmbed.
  - Images are fetched and stored via storage (change 11 provides the proxy; until then, cards
    are text-only).
  - Results go to `core.unfurls(url_hash, data, fetched_at)`, refreshed after 7 days.
- **Write-pipeline hook points**: `beforeSave(content, ctx)` stages are registered in order:
  bad words, link limits, spam (filled by `moderation`), then plugin filters (change 19).

## Risks / Trade-offs

- [Milkdown fidelity gaps] → the corpus test gates releases; the source mode is always available.
- [Re-sanitise on read adds latency during an upgrade] → it applies only on cache misses, and only to stale rows.
