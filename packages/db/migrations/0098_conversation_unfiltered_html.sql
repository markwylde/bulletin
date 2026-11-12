-- 0098: retain a pre-replace HTML rendering for private messages (moderation review).
--
-- Posts keep `body_html_unfiltered` so a replacement change applies to the original content;
-- messages need the same source to avoid rendering filters over already-filtered HTML.

SET LOCAL ROLE bulletin_owner;

ALTER TABLE core.conversation_messages
  ADD COLUMN IF NOT EXISTS body_html_unfiltered text;

RESET ROLE;
