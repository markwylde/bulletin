# 0007 — Content pipeline: Markdown, WYSIWYG, sanitised HTML

**Status:** Accepted (revised after review)

## Decision
- **Storage format is Markdown** (CommonMark + GFM + our extensions). No BBCode. Markdown is
  the source of truth; HTML is derived.
- **Editor**: **Milkdown** (ProseMirror, markdown-native), with a source/WYSIWYG toggle.
  - **Lossless round trip**: `md → editor → md` must be stable for all supported syntax,
    tested with a fixture corpus. Unsupported or unknown syntax (including syntax from a
    disabled plugin) is preserved as raw blocks, never dropped.
  - Must work well on mobile: toolbar above the keyboard, paste/upload images, emoticon picker.
  - Server-side draft autosave (debounced, `core.drafts`) per member and context.
- **Extensions**: `@mention`, `:emoticon:` (staff sets), quotes referencing a source post
  (multi-quote), attachments, embeds/unfurls, spoilers, code blocks with highlighting.
  Plugins may add extensions (ADR 0009).
- **Render at write time**: markdown → HAST → **allowlist sanitiser** (deny by default:
  tags, attributes and URL schemes; `rel="nofollow ugc noopener"`; no inline styles or scripts;
  embeds only via our own wrapper for allowlisted providers). The result is stored as
  `body_md`, `body_html`, `body_text` (for search) and `render_version`.
- **Quotes**:
  - On save, every quote must reference a source post the **author can read**. Otherwise the
    save is rejected.
  - The stored HTML contains a quote **placeholder** (`source_post_id` + snapshot ID), not the
    quoted text.
  - At fragment build, the placeholder is resolved for the viewer. If the viewer can read the
    source and it is not deleted, the snapshot text is shown with a link. Otherwise the viewer
    sees "Quoted content unavailable".
  - The source forum's `read` bit is part of the fragment's visibility deps (ADR 0005), and the
    fragment is tagged with the source topic, so source deletion or permission changes invalidate it.
  - **Quote snapshots are excluded from `body_text`**, and therefore from search, previews,
    notifications, emails, push, webhooks, RSS and unfurl descriptions. Every derived plain-text
    or summary output uses `body_text` only.
- **Re-render**: bumping `render_version` triggers a background job.
- **Emergency sanitiser fix**: bump `sanitiser_version`. Until a row is re-rendered, reads of
  rows below that version **re-sanitise on the fly** before caching. Reads never trust old HTML.
- Unfurls are fetched by workers (SSRF-protected: resolve and block private and link-local
  ranges after DNS, cap size and time, no redirects to private ranges). They are cached in
  `core.unfurls`, and images are proxied through storage (ADR 0019).
- The bad-word filter, link limits for new members and anti-spam checks run in the write
  pipeline before persistence.
- Signatures and custom profile fields use the same pipeline with stricter profiles.
- Edit history: each edit stores the previous `body_md` in `core.post_revisions`.

## Consequences
- Reads concatenate stored HTML, which is fast and cacheable.
- The sanitiser is security-critical and needs a dedicated XSS test corpus.
