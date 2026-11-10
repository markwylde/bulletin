# Tasks

## 1. Pipeline

- [x] 1.1 Implement `packages/content` parse → extensions → sanitise with profiles (post, signature, profile field, rules), producing `body_html`, `body_text` and versions; unit tests and an XSS corpus per profile
- [x] 1.2 Implement the mention, emoticon, spoiler and code-highlight extensions, with unit tests for each scenario
- [x] 1.3 Implement quote placeholders and snapshots (with `body_md` and versions), `quoted_forum_ids`, the author-can-read check behind a `QuoteSourceResolver` interface, source-context rules (no PM quotes in forum posts, same-conversation only), and quote exclusion from `body_text`; tests with fixture resolvers for every quote scenario (`topics-posts` wires forum posts and `conversations` wires messages, each re-running these tests)
- [x] 1.4 Implement snapshot redaction (`redacted_at`, `post:{id}:snapshots` tag, redaction notice rendering) exposed for the moderator edit form in `topics-posts`; tests for the redacted and redaction-off scenarios
- [x] 1.5 Implement the render-time replace-word transform hook (list supplied later by `moderation`), folded into `render_version` with on-read application for stale rows; unit test that `body_md` is never modified
- [x] 1.6 Implement the `beforeSave` stage registry (empty stages for bad words, link limits and spam) with unit tests for ordering
- [x] 1.7 Order `beforeSave` stages as plugin transforms, then core checks, then veto filters, then sanitise; a test that a transform adding a blocked word or extra links is still caught

## 2. Versioning

- [x] 2.1 Implement `render_version`/`sanitiser_version` checks with on-read re-sanitise and the resumable re-render job; integration test for the emergency-fix scenario

## 3. Embeds and unfurls

- [x] 3.1 Implement the embed allowlist (admin-configurable providers) and render wrapper, with unit tests
- [x] 3.2 Implement the unfurl worker (SSRF guard incl. redirects, size/time caps, OpenGraph/oEmbed parsing, cache, refresh) against `mocks/oembed`, with tests for the internal-address and preview-card scenarios

## 4. Editor

- [x] 4.1 Implement the Milkdown editor island (WYSIWYG/source toggle, custom nodes, raw markdown preservation) with the round-trip corpus test
- [x] 4.2 Implement the mobile toolbar, emoticon picker and mention autocomplete (`GET /api/members/suggest`), with E2E at 360/390/1440 including toolbar visibility
- [x] 4.3 Implement draft autosave and restore (API, overlay delivery, clear on submit), with integration tests and an E2E restore on a second browser profile
- [x] 4.4 Verify keyboard operation and accessible names with an E2E accessibility check

## 5. Staff screens and adoption

- [x] 5.1 Emoticon set manager (upload via the basic `packages/storage` client from the foundation, codes, alt text, order, editor visibility), with tests for duplicate codes and permission denial
- [x] 5.2 Switch forum rules and announcements to the pipeline (rules profile), with integration tests

## 6. Strings and seed

- [x] 6.1 Add en/es/fr strings for the editor UI, accessible names and errors; verify completeness
- [x] 6.2 Seed a default emoticon set and render the seeded rules and announcements through the pipeline; verify after `docker compose up --watch`

## 7. Feature flag

- [ ] 7.1 Register `unfurls`, `mentions` with `defineFlag` (off in production defaults, on in the seed), gate routes with `requireFlag`, templates with `{% if flags.<key> %}` and islands with `useFlag`; tests that each surface is absent (404 or not rendered) when off, and a cache variant test for the flag toggle
