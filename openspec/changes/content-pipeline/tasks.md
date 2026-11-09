# Tasks

## 1. Pipeline

- [ ] 1.1 Implement `packages/content` parse → extensions → sanitise with profiles (post, signature, profile field, rules), producing `body_html`, `body_text` and versions; unit tests and an XSS corpus per profile
- [ ] 1.2 Implement the mention, emoticon, spoiler and code-highlight extensions, with unit tests for each scenario
- [ ] 1.3 Implement quote placeholders, the author-can-read check on save, and quote exclusion from `body_text`; unit and integration tests for both quote scenarios
- [ ] 1.4 Implement the `beforeSave` stage registry (empty stages for bad words, link limits and spam) with unit tests for ordering

## 2. Versioning

- [ ] 2.1 Implement `render_version`/`sanitiser_version` checks with on-read re-sanitise and the resumable re-render job; integration test for the emergency-fix scenario

## 3. Embeds and unfurls

- [ ] 3.1 Implement the embed allowlist (admin-configurable providers) and render wrapper, with unit tests
- [ ] 3.2 Implement the unfurl worker (SSRF guard incl. redirects, size/time caps, OpenGraph/oEmbed parsing, cache, refresh) against `mocks/oembed`, with tests for the internal-address and preview-card scenarios

## 4. Editor

- [ ] 4.1 Implement the Milkdown editor island (WYSIWYG/source toggle, custom nodes, raw markdown preservation) with the round-trip corpus test
- [ ] 4.2 Implement the mobile toolbar, emoticon picker and mention autocomplete (`GET /api/members/suggest`), with E2E at 360/390/1440 including toolbar visibility
- [ ] 4.3 Implement draft autosave and restore (API, overlay delivery, clear on submit), with integration tests and an E2E restore on a second browser profile
- [ ] 4.4 Verify keyboard operation and accessible names with an E2E accessibility check

## 5. Staff screens and adoption

- [ ] 5.1 Emoticon set manager (upload, codes, alt text, order, editor visibility), with tests for duplicate codes and permission denial
- [ ] 5.2 Switch forum rules and announcements to the pipeline (rules profile), with integration tests

## 6. Strings and seed

- [ ] 6.1 Add en/es/fr strings for the editor UI, accessible names and errors; verify completeness
- [ ] 6.2 Seed a default emoticon set and render the seeded rules and announcements through the pipeline; verify after `docker compose up --watch`
