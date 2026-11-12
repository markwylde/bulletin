# Proposal

## Why

Moderators need the full classic toolset to keep the community healthy: approval queues,
reports, topic tools, multi-moderation, warnings, filters, bans and a complete log.

## What Changes

- Moderation queue: optional approval of new members' first N posts (configured in the staff app), per-group "posts require approval", and per-forum "approve all new topics/posts".
- Report centre: report posts, members and private messages; statuses, assignment, staff comments, and outcomes notified to reporters.
- Topic tools: merge, split, move, pin, lock, bulk actions, and multi-moderation macros.
- Warnings: warning reasons with points and expiry; thresholds trigger actions (mod queue, posting suspension, ban); member acknowledgement.
- Content filters: bad-word filter (replace or block), link limits and anti-spam rules for new members.
- Bans: member bans (permanent or timed, via the Banned group), IP/CIDR bans with reason and expiry, and IP lookups via audited PII access.
- Moderation log of every moderator action.

## Capabilities

### New Capabilities
- `moderation-queue`: holding content for approval.
- `reports`: member reports and the report centre.
- `topic-moderation`: topic and post tools, bulk actions and multi-moderation.
- `warnings`: warning points, expiry and automatic actions.
- `content-filters`: bad words, link limits and anti-spam rules.
- `ip-bans`: member bans, IP bans and IP lookups.
- `moderation-log`: the record of moderator actions.

### Modified Capabilities
- None.

## Impact

- Schema, user-app moderator controls, staff-app moderation sections, the write pipeline stages, PII definer functions for IP lookup, and events.
