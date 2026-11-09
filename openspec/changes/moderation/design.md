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
  path for staff to read PMs.
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
  - The link counter runs on the HAST, so it is accurate.
  - Duplicate detection uses a SHA-256 of normalised `body_text` per author in a 10-minute
    window (UNLOGGED table).
- **IP capture**: on post create and login, insert into `pii.post_ips` and `pii.ip_log` via a
  definer function (write-only for user_api). Lookups go through `pii.open_access` →
  `pii.read_post_ip(grant)`, per ADR 0012, from staff-api with step-up auth.
- **IP bans**: `ip_bans(cidr inet, reason, expires_at, created_by)` with a GiST index. The
  check runs in login and post middleware.
- **Log**: `moderation_log` is append-only. The app role has INSERT and SELECT only (no UPDATE
  or DELETE grants). Retention purge runs as the owner role.

## Risks / Trade-offs

- [Merge/split on huge topics] → batched renumbering inside the transaction; the load test covers a 10k-post topic.
- [False positives in anti-spam] → held, not deleted; labelled with the rule, so moderators can tune it.
