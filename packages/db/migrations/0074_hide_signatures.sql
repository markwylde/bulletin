-- 0074: the member preference that hides every signature for that member (member-profiles 2.1,
-- ADR 0006 overlay). Shared pages still carry the cached signature fragments; the overlay only
-- hides them for this viewer, so no cache variant is added for the preference.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.members
  ADD COLUMN IF NOT EXISTS hide_signatures boolean NOT NULL DEFAULT false;

RESET ROLE;
