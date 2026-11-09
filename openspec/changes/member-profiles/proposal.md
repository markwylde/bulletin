# Proposal

## Why

Members need identity and community presence: profiles, custom fields, signatures, ranks,
badges, friends and ignore lists, the member list, who's online, board stats and leaderboards.
These are classic IPB features that you confirmed.

## What Changes

- Profile pages: about, custom fields, stats (posts, reputation, joined, last active), badges, recent activity, friends/followers.
- Staff-defined custom profile fields with types, required/optional, and per-group visibility and editability.
- Signatures with group-controlled limits, and a member option to hide all signatures.
- Ranks: titles and pips by post count, plus custom titles if the group allows.
- Badges: definitions, manual awards and rule-based auto-awards (evaluated by workers on events).
- Ignore list (hide posts, block PMs and mentions) and friends (mutual friend requests). Following members is in `events-notifications`.
- Member list with search, filters and sorting; who's online; board statistics on the index; leaderboards.
- Member privacy options: hide online status, hide from member list.

## Capabilities

### New Capabilities
- `member-profiles`: profile pages, custom fields, signatures and privacy options.
- `member-relationships`: ignore lists and friends.
- `member-directory`: member list, who's online, board statistics and leaderboards.
- `ranks-badges`: post-count ranks, custom titles, and badges.

### Modified Capabilities
- None.

## Impact

- Schema, user-app profile and list routes, staff screens for fields/ranks/badges, workers for badge rules and leaderboards, and the overlay for ignore lists.
