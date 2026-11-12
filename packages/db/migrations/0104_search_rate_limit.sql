-- 0104: the user app enforces the search flood interval on read-path requests (ADR 0001,
-- 0003, 0017). `core.rate_buckets` is an UNLOGGED read-path buffer, like views and presence;
-- the user app now records search hits so repeated page requests are rate-limited in-process.
-- Search is the only new writer; every other row still belongs to user-api/workers.

GRANT INSERT, UPDATE, DELETE ON core.rate_buckets TO user_app;
