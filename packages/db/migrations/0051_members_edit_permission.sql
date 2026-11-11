-- 0051: grant the new `members.edit` permission to administrators (ADR 0005, 0019).
--
-- Avatar staff removal requires this permission. The registry default is false; the migration
-- mirrors the other registry permissions that administrators receive out of the box.

SET LOCAL ROLE bulletin_owner;

INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, 'members.edit', to_jsonb(true)
FROM core.groups g
WHERE g.key = 'administrators'
ON CONFLICT (group_id, key) DO NOTHING;

RESET ROLE;
