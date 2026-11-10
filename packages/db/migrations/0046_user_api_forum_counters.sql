-- 0046: posting transactions maintain the forum counters and last-post pointers (topics-posts).
-- `user_api` owns content writes (ADR 0001); forum structure writes stay in `staff_api`.

GRANT UPDATE ON core.forums TO user_api;
