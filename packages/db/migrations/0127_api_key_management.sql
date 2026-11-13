-- 0127: administrators manage API integrations (ADR 0016). Personal keys stay opt-in per
-- group through `api.personal_keys`; granting that setting is a group decision.

SET LOCAL ROLE bulletin_owner;

INSERT INTO core.group_settings (group_id, key, value)
SELECT id, 'acp.api', to_jsonb(true)
FROM core.groups
WHERE key = 'administrators'
ON CONFLICT (group_id, key) DO NOTHING;

RESET ROLE;
