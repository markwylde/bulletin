# Design

## Context

Uses the overlay (ADR 0006) for per-viewer state and events (change 12) for notifications
and badges.

## Goals / Non-Goals

**Goals:** cheap writes; cached post blocks stay valid when reactions change.

**Non-Goals:** reaction analytics beyond leaderboards (change 14).

## Decisions

- **Schema**: `reactions(id, icon, label_key, weight, position, enabled)`,
  `post_reactions(post_id, member_id, reaction_id)` with PK `(post_id, member_id)`,
  `reputation_entries(id, post_id, giver_id, receiver_id, points, source enum(vote, reaction),
  created_at)`, and `members.reputation` (denormalised).
- **Reaction totals fragment**: totals are stored as `posts.reaction_summary jsonb`, updated in
  the reaction mutation. The reaction bar is its own fragment, tagged `post:{id}:reactions`,
  so a reaction doesn't invalidate the post-body fragment.
- **Reputation via reactions**: the reaction mutation upserts a matching `reputation_entries`
  row (source `reaction`) when the setting is on. Toggling the setting enqueues a full recount job.
- **Daily allowance**: count of today's `reputation_entries` by giver, in board timezone,
  inside the transaction.
- **Recount**: `SUM(points)` over entries per member, run by a job.

## Risks / Trade-offs

- [Toggling "reactions affect reputation" on a big board] → the recount job runs in batches and shows progress in the staff app.
