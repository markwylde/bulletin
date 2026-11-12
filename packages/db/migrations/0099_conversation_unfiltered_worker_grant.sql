-- 0099: the content re-render worker writes the new unfiltered message column
-- (moderation review; ADR 0007). Column-level UPDATE grants from 0086 do not cover new columns.

GRANT SELECT (body_html_unfiltered), UPDATE (body_html_unfiltered)
  ON core.conversation_messages TO workers;
