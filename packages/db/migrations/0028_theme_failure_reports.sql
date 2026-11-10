-- 0028: the renderer's template-failure report (ADR 0008, 0012; page-rendering scenarios
-- "runaway loop" and "invalid props"). user_app appends entries to the existing admin log so
-- the staff app shows them next to other system events; it may not read the log.
--
-- The renderer has no member session, so rows carry no actor (a system event) and a
-- `theme_template` target with the details in the summary.

SET LOCAL ROLE bulletin_owner;

GRANT INSERT ON core.admin_log TO user_app;
GRANT USAGE ON SEQUENCE core.admin_log_id_seq TO user_app;

RESET ROLE;
