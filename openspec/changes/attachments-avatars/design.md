# Design

## Context

ADR 0019 is the contract; ADR 0018 defines the files origin. The S3 mock supports server-side
copy and presign.

## Goals / Non-Goals

**Goals:** the upload state machine, authorised delivery, and reusable storage helpers for
themes, plugins and exports later.

**Non-Goals:** video transcoding; virus scanning (an optional hook point is provided).

## Decisions

- **State machine**: `attachments.state` is one of `pending → snapshotted → processing →
  ready | rejected`. Each transition is a conditional `UPDATE … WHERE state = $prev`, making
  finalise and the job idempotent.
- **Quota**: `member_storage(member_id, used_bytes, reserved_bytes)`. A reservation adds the
  declared size under a row lock; finalise converts it to used bytes with the real size;
  expiry releases it.
- **Type detection**: magic-byte sniffing for allowed types (`file-type` library; justified),
  then a type-specific decode (sharp for images) as the real validation.
- **Download**: `GET /attachments/:id/:filename` → `can(download)` → presigned GET (60 s) with
  `response-content-type`, `response-content-disposition`, and the CSP/nosniff headers set by
  the files-origin proxy (Caddy adds headers for that host).
- **Inline images in posts**: the HTML references `/attachments/:id/…`, so every view
  re-authorises.
- **CDN rule** (ADR 0019): only the **302 on the forum origin** is CDN-cacheable, and only for
  session-less requests to guest-visible attachments: `s-maxage=15, stale-while-revalidate=15`,
  always inside the 60 s presign. Every other redirect is `private, no-store`. The files origin
  is never CDN-cached for attachments. Avatars, theme and plugin assets are the only
  CDN-cached objects there.
- **Avatars**: stored as `av/<member>/<sha256>.webp` in 3 sizes. Public avatar delivery goes
  through the files origin with `Cache-Control: public, max-age=31536000, immutable`.
  Initials avatars are rendered as inline SVG by the template (no request).
- **Virus scanning hook**: an optional `attachment.scan` stage in processing (no-op by
  default), so a plugin or ClamAV sidecar can be added later.

## Risks / Trade-offs

- [sharp native binary in Bun images] → pin the version; CI builds on both architectures.
- [Redirect per inline image adds latency] → the presigned URL is cached per viewer-variant for 30 s; the browser follows the redirect quickly.
