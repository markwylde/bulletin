# Proposal

## Why

The board needs its structure: categories, forums, unlimited sub-forums, redirect forums,
forum rules, topic prefixes and announcements. This activates the forum permission matrix
from change 6.

## What Changes

- Categories and forums in an unlimited-depth tree, with ordering and slugs.
- Forum types: normal and redirect (with click counting).
- Per-forum settings: description, rules box, password, show moderators, topic prefixes (required or optional), default sort, and language for search.
- Global and per-forum announcements with date ranges and group targeting.
- Staff screens to manage the tree (drag to reorder and reparent), forum settings and announcements.
- Board index and forum pages rendered with a basic layout (the full template system arrives in change 8).

## Capabilities

### New Capabilities
- `forums`: the category/forum tree, forum types and forum settings, including prefixes.
- `announcements`: global and forum announcements.

### Modified Capabilities
- None.

## Impact

- Migrations for forums, prefixes and announcements; staff-app sections; user-app index and forum routes.
