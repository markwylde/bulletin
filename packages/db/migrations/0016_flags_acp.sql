-- 0016: `acp.flags` gates the feature flag section (ADR 0010).
-- `groups-permissions` replaces these interim permission rows with the typed registry.

SET LOCAL ROLE bulletin_owner;

INSERT INTO core.group_acp_permissions (group_id, permission)
SELECT g.id, 'acp.flags'
FROM core.groups g
WHERE g.key = 'administrators'
ON CONFLICT DO NOTHING;

RESET ROLE;
