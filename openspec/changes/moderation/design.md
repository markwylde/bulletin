# Design

## Context

Builds on all content changes. IP data follows ADR 0012 (restricted class, two-transaction
grant). The write pipeline stages were reserved in `content-pipeline`.

## Goals / Non-Goals

**Goals:** complete IPB-era moderation; strict scoping by forum moderator powers.

**Non-Goals:** ML spam detection (a plugin can add a pipeline stage).

## Decisions

- **Visibility**: `posts.visibility` and `topics.visibility` (`visible`, `unapproved`,
  `soft_deleted`) plus `hold_reason`. Counters include only `visible` rows. Approve and reject
  are mutations with tags and events (`post.approved` triggers notifications, badges and
  promotions).
- **Approval decision**: a pure function `needsApproval(author, forum, content, filterFlags)`
  combining the new-member N, group restriction, forum setting, warning-imposed moderation
  and filter flags. It is unit-tested exhaustively.
- **Reports**: `reports(id, target_type, target_id, status, assignee, created_at)`,
  `report_reporters`, `report_comments`. PM access is via `report_pm_access(report_id,
  message_ids[])`, computed at report time (reported message plus 5 prior), and is the only
  path for staff to read PMs. Opening the report inserts `conversation_message_holds` for those
  messages (contract from `conversations`); closing it releases them, which lets the
  conversation removal job finish.
- **Merge and split**: done in one transaction with a lock on all affected topics in ID order
  (avoids deadlock). Post positions are renumbered and all affected tags are declared.
- **Multi-mod**: `multimod_actions(id, name, forums, steps jsonb)`. Steps run through the
  same mutation functions in one transaction, logged once with sub-steps.
- **Warnings**: `warning_reasons`, `warnings(member, reason, points, expires_at, revoked_at,
  content_ref, member_note, staff_note, ack_required, acked_at)`, `warning_thresholds(points,
  action, duration)`, and `member_restrictions(member, kind, until, source_warning)`. An
  expiry job runs hourly. Restrictions feed the group-settings merge as `restrict-any`
  overlays (`posts_require_approval`, `cannot_post`).
- **Filters**:
  - Bad words are compiled into one regex per mode, cached under tag `filters`.
  - *Block* runs as a `beforeSave` stage. *Replace* supplies the list to the content
    pipeline's render-time transform (ADR 0007). Changing the replace list bumps the filter
    version (part of `render_version`), which enqueues the re-render job. Stale rows are
    transformed on read until reached.
  - The link counter runs on the HAST, so it is accurate.
  - Duplicate detection uses a SHA-256 of normalised `body_text` per author in a 10-minute
    window (UNLOGGED table).
- **IP capture**: on post create and login, insert into `pii.post_ips` and `pii.ip_log` via a
  definer function (write-only for user_api). Lookups go through `pii.open_access` →
  `pii.read_post_ip(grant)`, per ADR 0012, from staff-api with step-up auth. The "other members
  from this IP" view uses `pii.read_members_by_ip(grant)`, a separate audited grant that only
  returns posts in forums where the actor has `mod.view_ips` (capped at 100 rows).
- **IP bans**: `ip_bans(cidr inet, reason, expires_at, created_by)` with a GiST index. The
  check runs in login and post middleware.
- **Log**: `moderation_log` is append-only. The app role has INSERT and SELECT only (no UPDATE
  or DELETE grants). Retention purge runs as the owner role.

## Risks / Trade-offs

- [Merge/split on huge topics] → batched renumbering inside the transaction; the load test covers a 10k-post topic.
- [False positives in anti-spam] → held, not deleted; labelled with the rule, so moderators can tune it.

## Personal data (ADR 0012 checklist)

| Data | Class | Purpose | Retention | Access | Export | Erasure |
|---|---|---|---|---|---|---|
| Post and login IPs (`pii.post_ips`, `pii.ip_log`) | Restricted | abuse investigation | 90 days | `pii.open_access` → `pii.read_post_ip` / `pii.read_members_by_ip`; `mod.view_ips` in that forum, step-up, audited | included (own IPs) | deleted |
| IP bans (`core.ip_bans`) | Security record | abuse prevention | until expiry (default 1 year) | `ban.manage` | excluded (legitimate interest, documented) | kept until expiry; requester told |
| Warnings and restrictions | Security record | moderation history | 2 years after expiry | the member (member note); staff with `warn.view` | member-visible fields included | kept with documented basis; requester told |
| Reports and report comments | Security record | moderation | 2 years after closure | moderators of the forum | reports the member filed | reporter link anonymised |
| Moderation log | Security record | accountability | 2 years | staff with `modlog.view` | excluded | actor and target anonymised |

## Feature flags (ADR 0010)

`warnings`, `multimod`. Reports, the queue, filters and IP tools are safety features, exempt under ADR 0010.

Gating: server routes use `requireFlag(key)` (404 when off), templates use `{% if flags.<key> %}`, and islands use `useFlag(key)`. Flags marked `affectsRender` are part of the cache variant (ADR 0006, 0010).
