-- 0080: a group referenced by a custom profile field's visibility rules cannot be deleted.
-- Cascading the last rule away would make the field public and expose existing values.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.profile_field_groups
  DROP CONSTRAINT IF EXISTS profile_field_groups_group_id_fkey;

ALTER TABLE core.profile_field_groups
  ADD CONSTRAINT profile_field_groups_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES core.groups (id) ON DELETE RESTRICT;

RESET ROLE;
