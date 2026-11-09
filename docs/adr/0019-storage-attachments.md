# 0019 — Storage, attachments and avatars

**Status:** Accepted

## Decision
### Buckets and access
- One **private** S3 bucket (via `Bun.S3Client`; `mocks/s3` locally). No public-read objects.
- Object keys are opaque (`att/<uuid>`, `av/<uuid>`, `theme/<id>/<hash>`, `plugin/<id>/<ver>/…`,
  `export/<uuid>`). Metadata lives in `core.attachments`, which is authoritative.

### Upload flow
1. `POST /api/attachments` (context: forum/topic or PM) checks `can(upload)`, the group
   quotas, the per-file size limit and the type allowlist. It then **reserves quota
   transactionally** (a row in `pending` state with a size limit) and returns a presigned PUT
   to `quarantine/<uuid>`, valid for 5 minutes with an exact content-length condition.
2. The client uploads, then calls `finalize`. Finalisation is an idempotent state machine
   (`pending → snapshotted → processing → ready | rejected`). In one step the API:
   - **server-side copies** the quarantine object to an immutable key `processing/<uuid>`,
   - records its size and SHA-256,
   - deletes the quarantine object, and marks the upload `snapshotted`.

   The presigned PUT may still be replayed against the quarantine key, but nothing ever reads
   that key again. Stray objects are removed by the orphan job. All later steps operate only on
   the snapshot and verify its checksum. A worker then:
   - checks magic bytes against the allowed types (the declared MIME type is not trusted),
   - for images: decodes, re-encodes (strips EXIF and metadata), and produces thumbnails
     (`sharp`; justified as libvips image processing, which Bun has no built-in for),
   - **SVG is not rendered inline**: it is rasterised to PNG for display, and the original is
     download-only,
   - moves the object to its final key, and marks the row `ready` with the real size.
3. Attachments become visible when the post referencing them is saved.
4. An **orphan job** deletes `pending` or unattached uploads older than 24 h and releases
   their quota. A weekly **reconciliation job** diffs bucket keys against `core.attachments`
   and removes stray objects.

### Download flow
- `GET /attachments/:id` on the forum origin checks `can(download)` on the **current**
  resource every time (ADR 0005). It then 302s to a **presigned GET on the files origin**
  (ADR 0018) valid for 60 s, with response overrides:
  - `Content-Disposition: attachment` for everything except allowlisted raster images
  - `Content-Type` set from the verified type
  - `X-Content-Type-Options: nosniff`
  - `Content-Security-Policy: sandbox; default-src 'none'`
- Revocation is therefore bounded to 60 s for already-issued links.
- **Guest-visible** attachments may be CDN-cached under the same 30 s revocation contract as
  guest pages (ADR 0006). Others are `private, no-store`.
- **Avatars** are public by design. They are served from the files origin via stable,
  content-hashed URLs, with long cache lifetimes. Changing an avatar creates a new key.

### Deletion
- Deleting an attachment row (soft-delete restore window, then hard delete), erasing a member
  or deleting a post enqueues object deletion. Reconciliation catches anything missed.

## Consequences
- The `sharp` native dependency is accepted for images.
- Attachment and avatar limits come from group settings (ADR 0005).
