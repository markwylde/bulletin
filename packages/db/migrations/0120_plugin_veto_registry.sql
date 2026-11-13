-- 0120: veto policies are readable by user-api even when plugin-host is unavailable.

ALTER TABLE core.plugin_registry
  DROP CONSTRAINT IF EXISTS plugin_registry_kind_check;
ALTER TABLE core.plugin_registry
  ADD CONSTRAINT plugin_registry_kind_check
  CHECK (kind IN ('setting', 'forum_action', 'flag', 'route', 'job', 'fragment', 'page', 'enricher', 'veto'));
