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
  - `user_app`, `user_api`, `staff_api`, `workers`: their own `core` grants only
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
- **Durable auditing, committed before release**: reading PII takes two calls in two transactions.
  1. `pii.open_access(session_token, purpose, resource)` validates the actor and permission,
     inserts the audit row and a single-use grant (60 s expiry), and returns the grant ID.
     The caller commits.
  2. `pii.read_*(grant_id, …)` returns data only if the grant's creating transaction is
     **committed**. It checks the stored `pg_current_xact_id()` from step 1 with
     `pg_xact_status(...) = 'committed'`. A grant created in the current transaction is still
     `in progress` and is refused. The read also checks the grant's actor, purpose and
     resource, then marks the grant consumed.

  No PII can leave the database without an already-committed audit record, regardless of how
  the caller batches statements.
- **Interactive staff reads** (two-transaction grant, step-up auth, granted to `staff_api` only):
  - `pii.read_post_ip(grant)`: the IP of one post, if the actor has `mod.view_ips` in its forum.
  - `pii.read_members_by_ip(grant)`: the reverse lookup. The grant's resource is a post ID
    (or an IP the actor already obtained through an audited read); it returns members who
    posted from that IP **only in forums where the actor has `mod.view_ips`**, with post IDs,
    capped at 100 rows. Each call is a separate audited grant.
- **System-purpose functions**: flows that have no interactive session use narrow definer
  functions. Each takes only the identifiers it needs, returns the minimum, and is granted to
  exactly one role.

  | Function | Granted to | Returns | Audit |
  |---|---|---|---|
  | `pii.resolve_identity(issuer, sub, email, name)` | user_api, staff_api | member_id | `access_log` row (purpose `login`) on create or email change |
  | `pii.record_session_meta(session_id, ip, ua)` | user_api, staff_api | void | write-only, no read |
  | `pii.record_post_ip(post_id, ip)` | user_api | void | write-only |
  | `pii.record_login_ip(member_id, ip)` | user_api, staff_api | void | write-only |
  | `pii.save_push_subscription(session_token, sub)` | user_api | device ID | write-only |
| `pii.list_push_devices(session_token)` | user_api | the session member's own devices: device ID, label, user agent family, created and last-used times (never endpoint or keys) | none (own non-secret metadata) |
| `pii.delete_push_device(session_token, device_id)` | user_api | void | write-only; only the session member's own devices |
  | `pii.delivery_target(intent_id, channel)` | workers | email address or push subscriptions for that delivery intent's recipient only | one `access_log` row per call (purpose `delivery`), in the same transaction as the job's delivery record |
  | `pii.list_own_sessions(session_token)` | user_api, staff_api | the session member's own sessions with IP and browser family | `access_log` row (purpose `own_data`) |
  | `pii.create_data_request(session_token, kind)` | user_api | request ID | write; one open request per kind |
  | `pii.list_data_requests(session_token, filters)` / `pii.update_data_request(session_token, id, action, reason)` | staff_api | requests (member ID, kind, status, dates; no restricted fields) / void | actor checked for `privacy.requests` in SQL; each update logged |
  | `pii.update_request_step(request_id, step, state)` | workers | void | logged against the request |
  | `pii.read_access_log(grant, filters)` | staff_api | access log rows | two-transaction grant, actor checked for `privacy.audit` |
  | `pii.read_login_ips(grant)` | staff_api | a member's login IPs and times | two-transaction grant, actor checked for `members.view_ips` (admins), step-up |
  | `pii.export_member(request_id)` / `pii.erase_member(request_id)` | workers | export data / void | logged against the data request |
  | `pii.purge_expired()` | workers | counts | summary row per run |

  - IP **ban checks** never read `pii`: bans live in `core.ip_bans`, and the request IP is
    compared in the app.
  - **Delivery intents**: every outbound message (notification email or push, digest, export
    ready, data-request updates, other system mail) is first recorded as
    `core.delivery_intents(id, member_id, kind, ref_id, channel, created_at, delivered_at)` in
    the transaction that decides to send it. `pii.delivery_target` checks that the intent
    exists, is undelivered, that the member is not erasing, and that the channel is still
    enabled for that kind (system kinds such as export-ready can't be disabled). It cannot be
    used to look up arbitrary members, and it works whether or not the `notifications` flag
    is on.
  - **Permission checks inside SQL**: interactive functions check the actor's power with
    `core.has_mod_power` (moderator powers, from `groups-permissions`) or `core.has_acp(member_id,
    permission)` (ACP permissions), and step-up with `core.sessions.last_auth_at`, so a bug in
    application code cannot bypass them.
  - Delivery reads use the single-transaction model rather than the two-transaction grant,
    because the data goes to the recipient themselves, not to a staff viewer. The audit row
    commits atomically with the delivery record, and a rolled-back delivery is retried and
    logged again.
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
- **Erasure fence**: accepting an erasure atomically sets `members.state = 'erasing'`, revokes
  every session, API key and push device, and from then on login (`pii.resolve_identity`),
  writes by or for the member, new delivery intents and job consumers refuse or skip that
  member. Steps run only after the fence commits, so nothing can recreate deleted data.
- **Erasure**: removes Restricted data and anonymises the member ("Deleted member #n").
  It also removes display-name history and old profile slugs, re-renders content that
  mentions the member so the old name disappears, redacts quote snapshots of their posts
  before deleting or anonymising posts, and removes poll votes, reputation entries (then
  recounts), badges, ignores, friendships and API keys. The
  admin chooses to keep posts anonymised or delete them. Revisions, drafts, attachments,
  notifications, reactions and follows are removed. Plugins **must** implement `gdpr.erase`.
  Retained security records (e.g. a ban) are kept with a documented basis, and the requester
  is told.
- Staff process requests from an ACP queue with deadlines.
- **Restores cannot resurrect erasures**: completed erasures, session and API-key revocations
  and push-device deletions are also appended to an **erasure journal** in object storage
  (`journal/<date>/<seq>.json`, IDs and timestamps only, outside the database rollback set).
  After a database restore, a startup step replays every journal entry newer than the restore
  point before any service reports ready (ADR 0020).

### Hygiene
- Logs and errors never contain emails, IPs or tokens (a redaction helper is enforced in
  `packages/config`, with a lint rule).
- Images have EXIF stripped on upload (ADR 0019).
- No non-essential cookies by default.
- Every feature spec touching personal data includes the checklist: class, purpose, retention,
  access permission, export, erasure.
