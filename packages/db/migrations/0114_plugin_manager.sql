-- 0114: fields the plugin manager renders (ADR 0009, task 5.2).

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.plugins
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS timings jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_error text;

-- Staff who administer the board can manage plugins; other groups stay denied.
INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, 'acp.plugins', 'true'::jsonb
FROM core.groups g
WHERE g.key IN ('administrators', 'super_moderators')
ON CONFLICT (group_id, key) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();

-- Plugin settings/grants queue audit events; staff_api appends to the buffer like user_app.
GRANT INSERT ON core.system_audit_buffer TO staff_api;
GRANT USAGE, SELECT ON core.system_audit_buffer_id_seq TO staff_api;

RESET ROLE;
