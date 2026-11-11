# Proposal

## Why

Members need to attach files and images to posts and set avatars. ADR 0019 defines a private,
authorised storage model that must be implemented before any upload feature.

## What Changes

- Upload flow: quota reservation, presigned PUT to quarantine, snapshot on finalise, worker validation and processing (magic bytes, EXIF strip, thumbnails, SVG rasterisation).
- Download flow: per-request `can(download)` and a short-lived presigned redirect to the files origin, with safe headers.
- Attachments in the editor (drag/drop, paste, mobile picker) and in posts (inline images, file list).
- Per-group quotas, allowed types and size limits.
- Orphan cleanup and bucket reconciliation jobs.
- Avatars: upload, crop, size limits per group, initials fallback, public content-hashed URLs.
- Image proxy for unfurl card images.

## Capabilities

### New Capabilities
- `attachments`: uploading, processing, authorising and deleting post and message attachments.
- `avatars`: member avatars and the initials fallback.

### Modified Capabilities
- None.

## Impact

- `packages/storage` (new), user-api, workers, the editor island, staff settings, the S3 mock. Adds `sharp`.
