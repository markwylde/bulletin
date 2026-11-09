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
- **Quotes are rendered by reference**: the quoted text is a snapshot at quote time, and
  `can()` controls whether the source link is shown.
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
