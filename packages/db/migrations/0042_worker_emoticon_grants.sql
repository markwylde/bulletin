-- 0042: the content re-render worker resolves `:code:` emoticons (ADR 0007).
--
-- 0040 granted the editor read path only. A re-render also loads the current emoticon rows,
-- otherwise stored emoticon text would be written back as plain text. The grant is read-only.

GRANT SELECT ON core.emoticons TO workers;
