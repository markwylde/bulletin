# Tasks

## 1. Reactions

- [ ] 1.1 Migrations for reactions, post_reactions and the reaction_summary column; reaction mutations (add, change, remove; no own posts) emitting `reaction.added`; integration tests including permission denial
- [ ] 1.2 Reaction bar island and fragment, the "who reacted" list, and own-reaction via the overlay; cache test that a reaction doesn't invalidate the post-body fragment; E2E at 360 and 1440
- [ ] 1.3 Staff reaction set manager (icon, labels, order, weight, enable), with tests

## 2. Reputation

- [ ] 2.1 Migrations for reputation_entries and members.reputation; give/receive rules (group permissions, min posts, daily limit, negatives, once per post), with tests for each scenario
- [ ] 2.2 Reaction-to-reputation link with setting toggle and recount job, with integration tests
- [ ] 2.3 Reputation display (profile, label scale, board toggle) in default theme templates, and the reputation label on the `member:{id}:card` fragment; tests including that a reputation change rebuilds the card but not post blocks
- [ ] 2.4 Staff removal and recount (logged), with tests including permission denial

## 3. Notifications

- [ ] 3.1 Add reaction and reputation notification types with coalescing, with integration tests

## 4. Strings and seed

- [ ] 4.1 Add en/es/fr strings for reaction labels, reputation labels and UI; verify completeness
- [ ] 4.2 Seed a default reaction set, reactions and reputation across seeded posts, and verify totals display after `docker compose up --watch`

## 5. Feature flag

- [ ] 5.1 Register `reactions`, `reputation` with `defineFlag` (off in production defaults, on in the seed), gate routes with `requireFlag`, templates with `{% if flags.<key> %}` and islands with `useFlag`; tests that each surface is absent (404 or not rendered) when off, and a cache variant test for the flag toggle
