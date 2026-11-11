-- 0053: the orphan/cleanup workers recompute quota and may need to create a member_storage row
-- for seeded or legacy attachments (ADR 0019). They still do not own arbitrary quota writes.

GRANT INSERT ON core.member_storage TO workers;
