-- 0041: the content re-render worker updates the derived content columns (ADR 0007).
--
-- 0039 added the rendered rules and announcement columns after the table grants were issued,
-- so the worker that keeps those rows current could not update them. The grants stay
-- column-level: the worker owns the derived HTML, text and versions, never the source markdown.

GRANT UPDATE (
  rules_html, rules_text, rules_render_version, rules_sanitiser_version
) ON core.forums TO workers;

GRANT UPDATE (
  body_html, body_text, render_version, sanitiser_version
) ON core.announcements TO workers;
