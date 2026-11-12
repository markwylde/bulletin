-- 0096: retain a pre-replace HTML rendering for read-time filter changes (moderation review).

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.posts
  ADD COLUMN IF NOT EXISTS body_html_unfiltered text;

RESET ROLE;

GRANT UPDATE ON core.member_bans TO workers;
