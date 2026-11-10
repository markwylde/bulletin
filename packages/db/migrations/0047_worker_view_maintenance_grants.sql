-- 0047: the minute worker flushes view counts and expires moved-topic stubs (topics-posts).

GRANT UPDATE (view_count) ON core.topics TO workers;
GRANT DELETE ON core.topics TO workers;
