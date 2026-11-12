-- 0089: reports, grouped reporters, staff comments and report-scoped PM access
-- (moderation 2.1-2.4; ADR 0011, 0012).
--
-- A report is the shared record for one target while it is open. Reporters and staff comments
-- hang off it. PM reports keep only the reported message and the five before it: that list is
-- the sole staff read path into a private conversation, and every read is logged.

SET LOCAL ROLE bulletin_owner;

CREATE TABLE IF NOT EXISTS core.reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_type text NOT NULL CHECK (target_type IN ('post', 'member', 'pm')),
  target_id bigint NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'resolved', 'rejected')),
  assignee_id bigint REFERENCES core.members (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- One report per target while it is being handled; after it closes a fresh report may open.
CREATE UNIQUE INDEX IF NOT EXISTS reports_open_target_key
  ON core.reports (target_type, target_id)
  WHERE status IN ('open', 'in_progress');

CREATE INDEX IF NOT EXISTS reports_status_created_idx
  ON core.reports (status, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS reports_assignee_idx
  ON core.reports (assignee_id, updated_at DESC)
  WHERE assignee_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.report_reporters (
  report_id bigint NOT NULL REFERENCES core.reports (id) ON DELETE CASCADE,
  reporter_id bigint NOT NULL REFERENCES core.members (id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('spam', 'abuse', 'harassment', 'off_topic', 'other')),
  comment text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 2_000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS report_reporters_reporter_idx
  ON core.report_reporters (reporter_id, created_at DESC);

CREATE TABLE IF NOT EXISTS core.report_comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  report_id bigint NOT NULL REFERENCES core.reports (id) ON DELETE CASCADE,
  actor_id bigint REFERENCES core.members (id) ON DELETE SET NULL,
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 5_000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_comments_report_idx
  ON core.report_comments (report_id, id);

-- The report-time snapshot of PM context: reported message plus up to five earlier messages.
-- Staff read messages only through this table, never by joining the whole conversation.
CREATE TABLE IF NOT EXISTS core.report_pm_access (
  report_id bigint NOT NULL REFERENCES core.reports (id) ON DELETE CASCADE,
  message_id bigint NOT NULL REFERENCES core.conversation_messages (id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (report_id, message_id)
);

CREATE INDEX IF NOT EXISTS report_pm_access_message_idx
  ON core.report_pm_access (message_id);

-- The moderation log arrives with the full moderation change. PM report views need it now:
-- the table is append-only for the app roles (INSERT and SELECT only at this stage).
CREATE TABLE IF NOT EXISTS core.moderation_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_member_id bigint REFERENCES core.members (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (char_length(btrim(action)) > 0),
  target_type text,
  target_id bigint,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS moderation_log_created_idx
  ON core.moderation_log (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS moderation_log_actor_idx
  ON core.moderation_log (actor_member_id, created_at DESC);

-- Report permissions are part of the staff group baseline even before the seed runs.
INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, p.permission, to_jsonb(true)
FROM core.groups g
CROSS JOIN (VALUES ('reports.members'), ('reports.pms')) AS p (permission)
WHERE g.key IN ('moderators', 'super_moderators', 'administrators')
ON CONFLICT (group_id, key) DO NOTHING;

RESET ROLE;

GRANT SELECT ON core.reports, core.report_reporters, core.report_comments
  TO user_app, user_api, staff_api, workers;
GRANT SELECT, INSERT, UPDATE, DELETE ON core.reports TO user_api, staff_api;
GRANT SELECT, INSERT, DELETE ON core.report_reporters, core.report_comments TO user_api, staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.reports_id_seq TO user_api, staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.report_comments_id_seq TO user_api, staff_api;

-- PM context is not readable by the rendering role: it is served only by the report API,
-- which writes the audit row in the same transaction (ADR 0012).
GRANT SELECT, INSERT, DELETE ON core.report_pm_access TO user_api, staff_api;

-- Report creation and closure maintain the retention holds. A reporter is a participant in
-- the conversation, so this does not widen staff access.
GRANT SELECT, INSERT, DELETE ON core.conversation_message_holds TO user_api;

GRANT INSERT, SELECT ON core.moderation_log TO user_api, staff_api;
GRANT USAGE, SELECT ON SEQUENCE core.moderation_log_id_seq TO user_api, staff_api;
