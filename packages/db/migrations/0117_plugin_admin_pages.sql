-- 0117: plugins may declare fixed admin page types (settings form, data table, log viewer).

ALTER TABLE core.plugin_registry
  DROP CONSTRAINT IF EXISTS plugin_registry_kind_check;
ALTER TABLE core.plugin_registry
  ADD CONSTRAINT plugin_registry_kind_check
  CHECK (kind IN ('setting', 'forum_action', 'flag', 'route', 'job', 'fragment', 'page'));
