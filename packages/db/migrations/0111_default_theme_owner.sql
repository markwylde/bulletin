-- 0111: existing installations created before theme management marked the bundled default
-- theme as a custom edit target. Restore its protected identity and activation (review).

SET LOCAL ROLE bulletin_owner;

UPDATE core.themes
SET source = 'core', is_active = true
WHERE name = 'default';

RESET ROLE;
