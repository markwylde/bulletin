-- 0050: attachments, post attachments, member storage and member avatars (ADR 0019).
--
-- One private bucket; `core.attachments` is authoritative. The row moves through
--   pending -> snapshotted -> processing -> ready | rejected
-- and every step is a conditional UPDATE on the previous state, so finalise and the
-- processing worker are idempotent. Quarantine keys are write-only after finalisation: the
-- server-side snapshot under `processing/<uuid>` is the only input later steps read.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.attachments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'snapshotted', 'processing', 'ready', 'rejected')),
  -- The member's original filename, shown in the post's file list; never used as a key.
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  -- What the client claimed. Only `verified_type` is ever served or rendered.
  declared_type text NOT NULL CHECK (char_length(declared_type) BETWEEN 1 AND 255),
  declared_bytes bigint NOT NULL CHECK (declared_bytes > 0),
  -- Presigned PUT target. A replayed PUT may still land here and is ignored.
  quarantine_key text NOT NULL UNIQUE,
  -- Immutable server-side copy of the finalised bytes.
  snapshot_key text UNIQUE,
  -- Final published object, moved out of `processing/` by the worker.
  storage_key text UNIQUE,
  size_bytes bigint CHECK (size_bytes > 0),
  -- SHA-256 of the snapshot at finalise, then of the processed object once ready.
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  verified_type text
    CHECK (verified_type IS NULL OR char_length(verified_type) BETWEEN 1 AND 255),
  rejection_code text
    CHECK (rejection_code IS NULL OR rejection_code ~ '^[a-z0-9_]{1,64}$'),
  download_count bigint NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  -- Orphan cleanup deadline; attaching to a post clears it (NULL), detaching restarts it.
  expires_at timestamptz DEFAULT now() + interval '24 hours',
  -- Soft-delete restore window before the object is removed (ADR 0019).
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachments_state_fields_check CHECK (
    (
      state = 'pending'
      AND snapshot_key IS NULL AND storage_key IS NULL
      AND size_bytes IS NULL AND sha256 IS NULL
      AND verified_type IS NULL AND rejection_code IS NULL
    )
    OR (
      state = 'snapshotted'
      AND snapshot_key IS NOT NULL AND storage_key IS NULL
      AND size_bytes IS NOT NULL AND sha256 IS NOT NULL
      AND verified_type IS NULL AND rejection_code IS NULL
    )
    OR (
      state = 'processing'
      AND snapshot_key IS NOT NULL AND storage_key IS NULL
      AND size_bytes IS NOT NULL AND sha256 IS NOT NULL
      AND verified_type IS NULL AND rejection_code IS NULL
    )
    OR (
      state = 'ready'
      AND storage_key IS NOT NULL
      AND size_bytes IS NOT NULL AND sha256 IS NOT NULL AND verified_type IS NOT NULL
      AND rejection_code IS NULL
    )
    OR (
      state = 'rejected'
      AND snapshot_key IS NOT NULL AND storage_key IS NULL
      AND rejection_code IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS attachments_member_idx
  ON core.attachments (member_id, created_at DESC, id DESC);

-- The orphan job scans expirable work by state; ready rows are only detached, never expired.
CREATE INDEX IF NOT EXISTS attachments_expiry_idx
  ON core.attachments (state, expires_at)
  WHERE state IN ('pending', 'snapshotted', 'processing');

CREATE INDEX IF NOT EXISTS attachments_state_idx
  ON core.attachments (state, updated_at);

-- ---------------------------------------------------------------------------------------------
-- Posts referencing attachments
-- ---------------------------------------------------------------------------------------------

-- Attachments become visible when the post that references them is saved (ADR 0019). Every
-- reference is also a cache dependency: changing it bumps the post's tags (ADR 0006).
CREATE TABLE IF NOT EXISTS core.post_attachments (
  post_id bigint NOT NULL REFERENCES core.posts (id) ON DELETE CASCADE,
  attachment_id bigint NOT NULL REFERENCES core.attachments (id) ON DELETE CASCADE,
  -- Body order for the file list; inline images also carry their placeholder position.
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  inline boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS post_attachments_post_idx
  ON core.post_attachments (post_id, position, attachment_id);

CREATE INDEX IF NOT EXISTS post_attachments_attachment_idx
  ON core.post_attachments (attachment_id);

-- ---------------------------------------------------------------------------------------------
-- Quota accounting
-- ---------------------------------------------------------------------------------------------

-- Per-group quotas are enforced by reserving against this row under a lock (ADR 0005, 0019).
-- `reserved_bytes` carries the declared size until finalise converts it to `used_bytes`, or
-- expiry releases it.
CREATE TABLE IF NOT EXISTS core.member_storage (
  member_id bigint PRIMARY KEY REFERENCES core.members (id) ON DELETE CASCADE,
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------
-- Avatars
-- ---------------------------------------------------------------------------------------------

-- Avatars are public and content-hashed (ADR 0019): `avatar_hash` feeds
-- `av/<member>/<sha256>-<variant>.webp`, so a change produces a new URL and old URLs stay
-- immutable. Staff removal may block new uploads for a period.
ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS avatar_hash text;

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS avatar_updated_at timestamptz;

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS avatar_blocked_until timestamptz;

ALTER TABLE core.members DROP CONSTRAINT IF EXISTS members_avatar_hash_check;
ALTER TABLE core.members
  ADD CONSTRAINT members_avatar_hash_check
  CHECK (avatar_hash IS NULL OR avatar_hash ~ '^[0-9a-f]{64}$');

RESET ROLE;

GRANT SELECT ON core.attachments, core.post_attachments, core.member_storage
  TO user_app, staff_api;

-- Upload, finalise, hide, restore and download counting all happen in user-api.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  core.attachments, core.post_attachments, core.member_storage
  TO user_api;

GRANT USAGE, SELECT ON SEQUENCE core.attachments_id_seq TO user_api;

-- The processing worker owns lifecycle state; the orphan job deletes rows and releases quota.
GRANT SELECT, UPDATE, DELETE ON
  core.attachments, core.post_attachments, core.member_storage
  TO workers;
