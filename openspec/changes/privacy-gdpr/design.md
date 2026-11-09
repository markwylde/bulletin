# Design

## Context

ADR 0012. Most restricted storage exists already (changes 3 and 16). Plugins expose
`gdpr.export` and `gdpr.erase` (change 19).

## Goals / Non-Goals

**Goals:** complete, testable data subject rights; enforced inventory.

**Non-Goals:** legal policy text (admins write it); cookie banner (no non-essential cookies).

## Decisions

- **Inventory**: SQL `COMMENT ON COLUMN … IS '@personal class=<class>'` in migrations. CI
  queries `pg_description` and compares against `docs/privacy/inventory.md`, a table parsed by
  the checker.
- **Export job**: streams JSON per section into a zip (Bun's built-in compression where
  possible, or `fflate`), uploads it to `export/<uuid>.zip`, and records it in
  `data_requests`. The link is an authenticated route that re-checks the member and expiry,
  then presigns for 60 s.
- **Erasure job**: an ordered, idempotent step list recorded in `data_request_steps`:
  revoke sessions → plugins erase → attachments → personal content → profile → restricted
  data → anonymise member. Each step can be retried. Post handling follows the admin's choice.
  The display name becomes `Deleted member #<seq>`.
- **Retention job**: a nightly pg-boss cron calls `pii.purge_expired()` (definer, workers role
  only) and core purges, using per-category settings in `privacy_settings`.
- **Audit viewer**: reads `pii.access_log` through a definer function restricted to `privacy.audit`.

## Risks / Trade-offs

- [Backups retain erased data for up to 35 days] → documented in the privacy policy template and inventory.
- [Erasure of a prolific member is heavy] → batched steps; progress visible in the queue.
