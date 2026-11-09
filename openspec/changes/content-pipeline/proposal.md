# Proposal

## Why

Posts, signatures, rules, announcements and PMs all need the same safe, fast content
handling: markdown in, sanitised HTML out at write time, and a WYSIWYG editor that works on
mobile (ADR 0007).

## What Changes

- Markdown (CommonMark + GFM) parsing with Bulletin extensions: mentions, emoticons, quotes (placeholders), spoilers, code highlighting, embeds and attachments (placeholders resolved later).
- Allowlist sanitiser with profiles: post, signature, profile field, rules/announcement.
- Write-time render storing markdown, HTML, plain text (excluding quotes) and render version.
- Re-render jobs, and on-the-fly re-sanitise for stale sanitiser versions.
- Milkdown-based editor island with source/WYSIWYG toggle, mobile toolbar, emoticon picker, mention autocomplete, and server draft autosave.
- Emoticon set management in the staff app.
- Unfurl fetching in workers with SSRF protection; embed allowlist.
- Bad-word filter hook point and link-limit hook point in the write pipeline (the rules themselves arrive in `moderation`).

## Capabilities

### New Capabilities
- `content-rendering`: how user markdown becomes safe HTML and plain text, including quotes, mentions, emoticons and embeds.
- `post-editor`: the editing experience, including drafts.

### Modified Capabilities
- None.

## Impact

- `packages/content`, `packages/ui/islands/Editor`, workers, staff-app (emoticons). Rules and announcements (change 7) switch to rendered markdown.
