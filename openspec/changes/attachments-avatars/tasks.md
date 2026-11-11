# Tasks

## 1. Storage core

- [x] 1.1 Implement `packages/storage` (Bun.S3Client wrapper, presign, server-side copy, key conventions) with contract tests against the S3 mock
- [x] 1.2 Migrations for attachments (state machine), post_attachments, member_storage and avatar fields; integration tests for state transitions

## 2. Upload pipeline

- [x] 2.1 Upload request endpoint (permission, quota reservation, type and size checks, presigned PUT) with integration tests for over-quota, disallowed type and permission denial
- [x] 2.2 Finalise endpoint (server-side snapshot, checksum, delete quarantine) and the processing worker (type sniffing, sharp re-encode, EXIF strip, thumbnails, SVG rasterise, scan hook); tests for the disguised-executable, GPS and replaced-after-finalise scenarios
- [x] 2.3 Orphan cleanup and reconciliation jobs, with integration tests

## 3. Delivery

- [x] 3.1 Download endpoint with per-request `can(download)`, 60 s presigned redirect, files-origin headers in Caddy, inline-vs-download rules, and redirect-only CDN caching for session-less guest-visible attachments; tests for unauthorised, revoked, HTML-attachment and guest-redirect-caching scenarios (via the CDN mock)
- [x] 3.2 Image proxy for unfurl card images, reusing the pipeline; integration test

## 4. Editor and posts

- [ ] 4.1 Editor upload UI (pick, drag, paste, mobile picker, progress) and the attachment extension in the content pipeline; E2E paste and upload at 360 and 1440
- [ ] 4.2 Post rendering of inline images and the file list with download counts, with the cache variant harness applied; integration tests
- [ ] 4.3 "My attachments" page with quota usage and deletion, plus moderator removal; tests including permission denial
- [ ] 4.4 Attachment deletion (member or moderator) bumps the tags of referencing posts in the same transaction; integration test that the post stops showing it and its cached page is invalidated

## 5. Avatars

- [ ] 5.1 Avatar upload, crop UI and processing to 3 sizes with group limits; tests for the upload and group-disallowed scenarios; E2E crop at 360
- [ ] 5.2 Add the uploaded avatar to the `member:{id}:card` fragment, bumping `member:{id}` on avatar change or removal; invalidation test that post blocks are not re-rendered
- [ ] 5.3 Initials fallback in the default theme templates, with a unit test for stable colour
- [ ] 5.4 Staff avatar removal with block period, logged; integration test with permission denial
- [ ] 5.5 Unfurl image proxy (fetch through the SSRF-safe client, re-encode with sharp, store under `unfurl/<hash>`, serve from the files origin) with a test for the preview-card image scenario

## 6. Settings, strings and seed

- [ ] 6.1 Group settings entries for quotas, types, sizes and avatar limits, plus board settings for allowed types; tests for merge behaviour
- [ ] 6.2 Add en/es/fr strings for upload UI, errors, attachment lists and avatar UI; verify completeness
- [ ] 6.3 Seed avatars for a subset of members, image and file attachments in posts (including one in a staff-only forum), and verify after `docker compose up --watch`

## 7. Feature flag

- [ ] 7.1 Register `attachments`, `avatar_upload` with `defineFlag` (off in production defaults, on in the seed), gate routes with `requireFlag`, templates with `{% if flags.<key> %}` and islands with `useFlag`; tests that each surface is absent (404 or not rendered) when off, and a cache variant test for the flag toggle
