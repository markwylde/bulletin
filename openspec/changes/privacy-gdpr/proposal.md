# Proposal

## Why

You require GDPR compliance by design. ADR 0012 defines data classes, restricted storage,
retention and data subject rights. Earlier changes created the `pii` schema and IP capture;
this change completes retention, export, erasure, the personal-data inventory and the staff
request queue.

## What Changes

- Personal-data inventory (`docs/privacy/inventory.md`) and the CI check on `@personal` columns.
- Configurable retention policies with a nightly purge/anonymise job.
- Member data export (JSON + attachments, expiring link).
- Member erasure (anonymise or delete posts, purge restricted data, remove personal content, plugin erase hooks, retained-record notice).
- Staff data-request queue with deadlines, and an audit view of PII access.
- Privacy settings page for members, and a privacy policy page managed by admins.

## Capabilities

### New Capabilities
- `privacy`: retention, export, erasure, PII access auditing and the personal-data inventory.

### Modified Capabilities
- None.

## Impact

- workers (retention, export, erasure), staff-app data requests and PII access log, user-app privacy page, `pii` functions, the plugin SDK GDPR hooks (from change 19), storage (export objects).
