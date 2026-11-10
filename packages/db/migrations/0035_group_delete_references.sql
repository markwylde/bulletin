-- 0035: deleting a group must not widen an audience (ADR 0005, 0006).
--
-- `announcement_groups` and `prefix_groups` store an audience as an allow-list. The absence of
-- rows means "everyone", so cascading a group deletion would turn a private announcement or a
-- restricted prefix public. Keep the rows and reject the delete instead: staff remove the
-- reference explicitly before deleting the group.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.announcement_groups
  DROP CONSTRAINT IF EXISTS announcement_groups_group_id_fkey,
  ADD CONSTRAINT announcement_groups_group_id_fkey
    FOREIGN KEY (group_id) REFERENCES core.groups (id) ON DELETE RESTRICT;

ALTER TABLE core.prefix_groups
  DROP CONSTRAINT IF EXISTS prefix_groups_group_id_fkey,
  ADD CONSTRAINT prefix_groups_group_id_fkey
    FOREIGN KEY (group_id) REFERENCES core.groups (id) ON DELETE RESTRICT;

RESET ROLE;
