-- 0045: staff forum deletion moves or deletes the forum's topics (topics-posts).
--
-- Forum administration is a staff-api write; topic content writes stay in user-api. This is
-- the narrow permission the delete-forum transaction needs.

GRANT UPDATE, DELETE ON core.topics TO staff_api;
