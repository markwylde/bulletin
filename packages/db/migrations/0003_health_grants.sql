-- 0003: readiness checks read migration state; this is metadata, not content.

SET LOCAL ROLE bulletin_owner;

GRANT SELECT ON core.schema_migrations TO user_app, user_api, staff_api, workers;
