-- 0079: automatic badge rules run in the workers role (member-profiles 5.4). The worker only
-- reads definitions and rules and inserts/updates awards; staff_api still owns the definitions.

SET LOCAL ROLE bulletin_owner;
RESET ROLE;

GRANT SELECT ON core.badges, core.member_badges, core.badge_rules TO workers;
GRANT INSERT, UPDATE, DELETE ON core.member_badges TO workers;
GRANT USAGE, SELECT ON SEQUENCE core.member_badges_id_seq TO workers;
