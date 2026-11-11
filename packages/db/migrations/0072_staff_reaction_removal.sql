-- 0072: staff reputation removal also removes the underlying reaction (reputation spec,
-- staff controls). Reputation entries derive from `post_reactions`, so a removed abusive vote
-- must remove the reaction as well or the next recount recreates it.

SET LOCAL ROLE bulletin_owner;

RESET ROLE;

GRANT DELETE ON core.post_reactions TO staff_api;
GRANT UPDATE (reaction_summary) ON core.posts TO staff_api;
