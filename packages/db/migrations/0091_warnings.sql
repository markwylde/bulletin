-- 0091: warnings, thresholds and member restrictions (moderation 4.1-4.3; ADR 0005, 0011, 0012).
--
-- A warning is the durable member-visible record. Active points are computed from unexpired,
-- unrevoked rows; threshold actions materialise as member_restrictions and never lift just
-- because points later drop.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.warning_reasons (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  points integer NOT NULL CHECK (points BETWEEN 0 AND 1_000),
  expiry_days integer NOT NULL DEFAULT 30 CHECK (expiry_days BETWEEN 0 AND 3_650),
  allow_points_override boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.warning_reason_labels (
  reason_id bigint NOT NULL REFERENCES core.warning_reasons (id) ON DELETE CASCADE,
  locale text NOT NULL CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  PRIMARY KEY (reason_id, locale)
);

CREATE TABLE IF NOT EXISTS core.warnings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  reason_id bigint REFERENCES core.warning_reasons (id) ON DELETE SET NULL,
  points integer NOT NULL CHECK (points BETWEEN 0 AND 1_000),
  expires_at timestamptz NOT NULL,
  expired_at timestamptz,
  revoked_at timestamptz,
  revoked_by bigint REFERENCES core.members (id) ON DELETE SET NULL,
  revoke_reason text,
  content_type text CHECK (content_type IS NULL OR content_type IN ('post', 'member')),
  content_id bigint,
  member_note text NOT NULL DEFAULT '',
  staff_note text NOT NULL DEFAULT '',
  ack_required boolean NOT NULL DEFAULT false,
  acked_at timestamptz,
  issued_by bigint REFERENCES core.members (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warnings_content_pair_check CHECK (
    (content_type IS NULL AND content_id IS NULL)
    OR (content_type IS NOT NULL AND content_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS warnings_member_active_idx
  ON core.warnings (member_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS warnings_ack_idx
  ON core.warnings (member_id)
  WHERE ack_required AND acked_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS warnings_expiry_idx
  ON core.warnings (expires_at)
  WHERE expired_at IS NULL AND revoked_at IS NULL;

-- The notification centre reads the reason and member note through this link.
ALTER TABLE core.notifications
  ADD COLUMN IF NOT EXISTS warning_id bigint REFERENCES core.warnings (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS notifications_warning_idx
  ON core.notifications (warning_id)
  WHERE warning_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.warning_thresholds (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  points integer NOT NULL CHECK (points BETWEEN 1 AND 1_000),
  action text NOT NULL CHECK (action IN ('mod_queue', 'suspend', 'ban')),
  duration_hours integer CHECK (duration_hours IS NULL OR duration_hours BETWEEN 1 AND 87_600),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT warning_thresholds_duration_check CHECK (
    action = 'ban' OR duration_hours IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS warning_thresholds_points_idx
  ON core.warning_thresholds (points, id);

CREATE TABLE IF NOT EXISTS core.member_restrictions (
  member_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  kind text NOT NULL
    CHECK (kind IN ('posts_require_approval', 'cannot_post', 'banned')),
  -- NULL means permanent (a ban); otherwise the restriction lifts at this time.
  until timestamptz,
  source_warning_id bigint REFERENCES core.warnings (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, kind)
);

CREATE INDEX IF NOT EXISTS member_restrictions_until_idx
  ON core.member_restrictions (until)
  WHERE until IS NOT NULL;

-- The new ACP section belongs to administrators; the seed/groups matrix leaves super
-- moderators with their existing ACP subset.
INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, 'acp.warnings', to_jsonb(true)
FROM core.groups g
WHERE g.key = 'administrators'
ON CONFLICT (group_id, key) DO NOTHING;

RESET ROLE;

GRANT SELECT ON core.warning_reasons, core.warning_reason_labels, core.warnings,
  core.warning_thresholds, core.member_restrictions
  TO user_app, user_api, staff_api, workers;
GRANT INSERT, UPDATE, DELETE ON core.warning_reasons, core.warning_reason_labels,
  core.warning_thresholds TO staff_api;
GRANT INSERT, UPDATE, DELETE ON core.warnings, core.member_restrictions TO user_api;
GRANT UPDATE ON core.warnings TO workers;

GRANT USAGE, SELECT ON SEQUENCE core.warning_reasons_id_seq,
  core.warning_thresholds_id_seq TO staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.warnings_id_seq TO user_api;
