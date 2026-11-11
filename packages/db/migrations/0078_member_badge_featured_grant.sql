-- 0078: members choose their own featured badges (member-profiles 5.2). Definitions and
-- awards stay staff-managed; user_api can only toggle the per-member `featured` flag.

SET LOCAL ROLE bulletin_owner;
RESET ROLE;

GRANT UPDATE (featured) ON core.member_badges TO user_api;
