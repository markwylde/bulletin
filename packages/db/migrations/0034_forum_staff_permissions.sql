-- 0034: staff permissions for forum structure and announcements (ADR 0005, 0010).
-- Administrators get both by default. The registry owns the labels and types; this migration
-- grants the existing built-in administrator group so the new screens are usable after seed.

SET LOCAL ROLE bulletin_owner;

INSERT INTO core.group_settings (group_id, key, value)
SELECT g.id, p.permission, to_jsonb(true)
FROM core.groups g
CROSS JOIN (VALUES ('acp.forums'), ('acp.announcements')) AS p (permission)
WHERE g.key = 'administrators'
ON CONFLICT (group_id, key) DO NOTHING;

RESET ROLE;
