# attachments Specification

## Purpose
Lets members attach files and images to posts and messages safely. Files are visible only to
those allowed to see the content, and are harmless to download.

## Requirements

### Requirement: Upload permission and limits
Uploading SHALL require `upload` on the target forum (or conversation access), and SHALL respect the member's effective quota, per-file size limit and allowed file types.

#### Scenario: Over quota
- **WHEN** a member whose remaining quota is 2 MB uploads a 5 MB file
- **THEN** the upload is refused before any bytes are sent, with the remaining quota shown

#### Scenario: Disallowed type
- **WHEN** a member uploads a file type not allowed for their groups
- **THEN** the upload is refused

### Requirement: Content verification
An uploaded file's type SHALL be determined from its content, not its name or declared type. Files whose content does not match an allowed type SHALL be rejected.

#### Scenario: Disguised executable
- **WHEN** a member uploads an executable renamed to `photo.jpg`
- **THEN** processing rejects it, and the member sees an error

### Requirement: Image processing
Images SHALL be re-encoded with all metadata (including location data) removed, and thumbnails SHALL be generated. SVG files SHALL be displayed only as rasterised images. The original SVG SHALL be available only as a download.

#### Scenario: GPS stripped
- **WHEN** a member uploads a photo containing GPS EXIF data
- **THEN** the stored image contains no EXIF data

### Requirement: Upload integrity
Only the exact bytes present at finalisation SHALL be processed and published. Later uploads to the same upload URL SHALL have no effect.

#### Scenario: Replaced after finalise
- **WHEN** a client re-uploads different bytes to the presigned URL after finalising
- **THEN** the published attachment still contains the finalised bytes

### Requirement: Authorised downloads
Every attachment download SHALL check the viewer's current `download` permission on the content containing it. An authorised viewer SHALL receive a link valid for at most 60 seconds, served from the separate files origin.

#### Scenario: Unauthorised download
- **WHEN** a guest requests an attachment from a members-only forum
- **THEN** the response is 403

#### Scenario: Revoked access
- **WHEN** a member's access is revoked after they obtained a download link
- **THEN** the link stops working within 60 seconds

#### Scenario: Guest redirect caching
- **WHEN** a guest-visible attachment is requested without a session
- **THEN** only the redirect is publicly cacheable, for no more than 30 seconds including staleness, and the attachment bytes are not cached by the CDN

### Requirement: Safe delivery
Attachments SHALL be served with their verified content type, `nosniff`, and a sandboxing Content Security Policy. Everything except allowlisted raster images SHALL be served as a download, not displayed inline.

#### Scenario: HTML attachment
- **WHEN** a member downloads an attached `.html` file
- **THEN** the browser downloads it, and does not render it

### Requirement: Attachments in posts
Members SHALL attach files via the editor by picking, dragging or pasting. Images SHALL be insertable inline. Other files SHALL be listed below the post with name, size and download count.

#### Scenario: Paste image
- **WHEN** a member pastes an image into the editor
- **THEN** it uploads and appears inline in the editor

### Requirement: Cleanup
Uploads never attached to a saved post or message SHALL be deleted after 24 hours, and their quota released. Stored objects with no record SHALL be removed by reconciliation.

#### Scenario: Abandoned upload
- **WHEN** a member uploads a file and never posts
- **THEN** after 24 hours the file is deleted, and their quota usage decreases

### Requirement: Attachment management
Members SHALL view and delete their own attachments and see their quota usage. Moderators with edit power SHALL remove attachments from posts in their forums.

#### Scenario: Member deletes attachment
- **WHEN** a member deletes one of their attachments from their attachment list
- **THEN** it no longer appears in the post, and their quota usage decreases

### Requirement: Unfurl images proxied
Preview-card images SHALL be fetched by the unfurl worker, re-encoded and served from the files origin. The viewer's browser SHALL never load them from the third-party site.

#### Scenario: Preview card image
- **WHEN** a post's unfurled link has an OpenGraph image
- **THEN** the card shows that image served from the files origin
