# 0012 — Privacy, PII and GDPR

**Status:** Accepted (revised after review)

## Context
We process personal data: identity, IPs, device identifiers, and user-generated content.
We must be GDPR compliant by design. Database access controls must hold even if application
code has a bug.

## Decision
### Data classification
| Class | Examples | Where | Rules |
|---|---|---|---|
| **Restricted** | DarkAuth issuer/sub, email, IP logs, session IP/UA, push subscriptions, data requests | schema `pii` | access only via audited definer functions |
| **Personal content** | display name, profile fields, signature, posts, PMs, attachments, reactions, follows | `core` + storage | normal `can()` rules; included in export/erasure |
| **Security records** | IP/CIDR bans, warnings, mod log, PII access log | `core` / `pii` | personal data; retention + documented legitimate interest |
| **Derived** | caches, search vectors, materialisations, job rows, emails sent | various | IDs only where possible; purged by invalidation/expiry |

IP bans **are personal data**. They have a reason, an expiry (default 1 year, configurable),
and an access permission.

### Database roles and privileges
- `bulletin_owner` (NOLOGIN) owns `core`. `pii_owner` (NOLOGIN) owns `pii` and its functions.
- Login roles have **no table privileges on `pii`** at all:
  - `user_api`, `staff_api`, `workers`: their own `core` grants only
  - `plugin_<id>` (ADR 0009)
- `pii` tables have RLS **enabled and forced**, with policies that allow only `pii_owner`.
  This is defence in depth if a grant is ever added by mistake.
- Access is **only** through `SECURITY DEFINER` functions owned by `pii_owner`, which:
  - have `SET search_path = pii, pg_temp` pinned, with all references schema-qualified,
  - have `REVOKE EXECUTE … FROM PUBLIC`, and are granted per role and purpose (e.g.
    `pii.post_ips_for_forum()` to `staff_api` only; `pii.purge_expired()` to `workers` only),
  - **derive the actor from a trusted credential, not a caller-supplied ID**: interactive
    functions take the raw session token, look up `core.sessions` themselves, then check the
    actor's permission for that resource (e.g. `mod.view_ips` on the forum),
  - write an audit row to `pii.access_log`.
- **Durable auditing**: PII-reading functions refuse to run inside an explicit multi-statement
  transaction (they check `statement_timestamp() = transaction_timestamp()`). The read and its
  audit row therefore commit together or not at all.
- Migrations run as owners; app roles cannot run DDL.
- CI tests prove each app role is denied direct `SELECT`/`INSERT` on every `pii` table and on
  every function it has no grant for.

### Retention (configurable in the staff app; defaults)
- IP logs: 90 days
- Session IP/UA: 30 days
- Revoked sessions: 7 days
- PII access log: 2 years
- IP bans: until expiry
- Exports: 7 days
- Backups: 35-day rolling window (erasure propagates as backups expire; documented)

A nightly worker purges or anonymises expired rows.

### Data subject rights
- **Inventory**: `docs/privacy/inventory.md` lists every location of personal data, including
  plugin schemas, storage objects, revisions, drafts, events, deliveries, notifications, emails
  in flight, caches and backups. CI fails if a migration adds a column tagged `@personal`
  that is not in the inventory.
- **Export**: member-initiated. A worker builds JSON plus attachments, stored privately, and
  emails an expiring link. Plugins with personal data **must** implement `gdpr.export`.
- **Erasure**: removes Restricted data and anonymises the member ("Deleted member #n"). The
  admin chooses to keep posts anonymised or delete them. Revisions, drafts, attachments,
  notifications, reactions and follows are removed. Plugins **must** implement `gdpr.erase`.
  Retained security records (e.g. a ban) are kept with a documented basis, and the requester
  is told.
- Staff process requests from an ACP queue with deadlines.

### Hygiene
- Logs and errors never contain emails, IPs or tokens (a redaction helper is enforced in
  `packages/config`, with a lint rule).
- Images have EXIF stripped on upload (ADR 0019).
- No non-essential cookies by default.
- Every feature spec touching personal data includes the checklist: class, purpose, retention,
  access permission, export, erasure.
