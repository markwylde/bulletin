# Proposal

## Why

You chose to have both reactions and reputation. Reactions give lightweight feedback on
posts; reputation is the classic IPB member score. Both can be controlled per group.

## What Changes

- Staff-defined reaction set (emoji or image, label, reputation weight, enabled/disabled).
- Reacting to posts (one reaction per member per post), with "who reacted" lists.
- Reputation: positive/negative points on posts, with a per-group daily limit, a minimum post count to give, and per-group permission to give or receive; reputation total on profiles and posts.
- Optional link between reactions and reputation (each reaction's weight).
- Notifications for reactions and reputation.
- Staff tools to remove reactions or reputation and to recount.

## Capabilities

### New Capabilities
- `reactions`: reacting to posts with staff-defined reactions.
- `reputation`: member reputation points from feedback on their posts.

### Modified Capabilities
- None.

## Impact

- Schema, user-api, post templates (reaction bar island), overlay ("you reacted"), staff screens, and events (`reaction.added`, `reputation.given`).
