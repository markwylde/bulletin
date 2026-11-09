-- 0014: board settings and the interim `board.view_offline` group permission.
-- `groups-permissions` replaces the interim permission rows with the typed registry.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.board_settings
  ADD COLUMN IF NOT EXISTS offline boolean NOT NULL DEFAULT false;

ALTER TABLE core.board_settings
  ADD COLUMN IF NOT EXISTS offline_message text NOT NULL DEFAULT '';

ALTER TABLE core.group_acp_permissions
  DROP CONSTRAINT IF EXISTS group_acp_permissions_permission_check;

ALTER TABLE core.group_acp_permissions
  ADD CONSTRAINT group_acp_permissions_permission_check
  CHECK (permission ~ '^(acp|board)\.');

INSERT INTO core.group_acp_permissions (group_id, permission)
SELECT g.id, 'board.view_offline'
FROM core.groups g
WHERE g.key = 'administrators'
ON CONFLICT DO NOTHING;

GRANT INSERT ON core.board_settings TO staff_api;

RESET ROLE;
