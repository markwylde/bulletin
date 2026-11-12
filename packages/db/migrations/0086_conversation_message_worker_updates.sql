-- 0086: the content re-render worker may update the rendered message columns
-- (conversations review finding P2; ADR 0007).

GRANT UPDATE (body_html, body_text, render_version, sanitiser_version)
  ON core.conversation_messages TO workers;
