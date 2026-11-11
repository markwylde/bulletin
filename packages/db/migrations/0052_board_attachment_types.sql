-- 0052: board-wide attachment type allowlist (ADR 0019).
--
-- Groups decide whether images/documents are allowed at all; the board narrows the concrete
-- MIME types every group may upload. The default is the shipped set from the content pipeline.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.board_settings
  ADD COLUMN IF NOT EXISTS attachment_allowed_types text[] NOT NULL DEFAULT ARRAY[
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif',
    'image/svg+xml',
    'application/pdf',
    'application/zip',
    'text/plain',
    'text/html',
    'text/csv'
  ]::text[];

RESET ROLE;
