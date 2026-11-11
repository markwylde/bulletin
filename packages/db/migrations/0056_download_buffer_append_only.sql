-- 0056: the download buffer is append-only for user_app (ADR 0001, 0012).
-- Workers aggregate and delete it; the web read role only inserts.

REVOKE SELECT, DELETE ON core.attachment_download_buffer FROM user_app;
