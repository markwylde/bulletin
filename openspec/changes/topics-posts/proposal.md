# Proposal

## Why

Topics and posts are the forum. This change delivers the classic IPB topic experience on
top of permissions, caching and the content pipeline.

## What Changes

- Starting topics (with prefix), replying, multi-quote, editing within the edit window, and edit history.
- Soft delete and restore by authors and moderators; hard delete by moderators.
- Pinned and locked topics, moved-topic redirect stubs, view counts, and paging.
- Linear topic view with pagination and jump-to-first-unread.
- Polls attached to topics: multiple questions, single or multiple choice, close date, results visibility.
- Read/unread tracking per topic and forum, with "mark forum read" and "mark all read".
- Flood control and other posting limits from group settings.
- Counters (forum, topic, member post counts) and last-post info, maintained transactionally.

## Capabilities

### New Capabilities
- `topics`: creating, listing, viewing and managing topics.
- `posts`: replying, editing, history and deletion.
- `polls`: polls attached to topics.
- `read-tracking`: unread state for topics and forums.

### Modified Capabilities
- None.

## Impact

- Core schema for topics, posts, revisions, polls and read markers; user-app topic routes; overlay additions; mutations with cache tags.
