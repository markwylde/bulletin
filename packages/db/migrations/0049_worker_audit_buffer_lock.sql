-- 0049: draining the audit buffer uses SELECT … FOR UPDATE SKIP LOCKED, which requires UPDATE
-- privilege on the buffer even though rows are only deleted (topics-posts reviewer finding 9).

GRANT UPDATE ON core.system_audit_buffer TO workers;
