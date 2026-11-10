-- 0026: the demo route (task 4.2) replaces the spike S1 route, so its hook fragments table
-- loses the spike name. `plugin-platform` will own real hook fragments (ADR 0009).
-- Grants follow the table, and the primary key/check constraint names stay as they were.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE IF EXISTS core.render_spike_hooks RENAME TO hook_fragments;

RESET ROLE;
