# topics Specification

## Purpose
Lets members start and browse discussions in forums, with the classic topic list and topic
view of a traditional forum.

## Requirements

### Requirement: Start a topic
Members with `start` on a forum SHALL create a topic with a title (3–150 characters), a first post, an optional or required prefix, and an optional poll.

#### Scenario: Create topic
- **WHEN** a member with `start` submits a valid title and body
- **THEN** the topic appears at the top of the forum's topic list, and the forum's counts increase

#### Scenario: No start permission
- **WHEN** a member without `start` submits a new topic via the API
- **THEN** the API responds 403

### Requirement: Topic list
A forum's topic list SHALL show pinned topics first, then topics ordered by last post date (or the forum's default sort). Each row SHALL show prefix, title, starter, replies, views and last poster. Lists SHALL be paginated.

#### Scenario: Pinned first
- **WHEN** a forum has a pinned topic older than other topics
- **THEN** it is listed above the unpinned topics

### Requirement: Linear topic view
A topic SHALL show its posts oldest first, paginated with a board-configurable number per page. Each post SHALL show the author's display name, avatar, group title, post count, join date and the post content. Later changes add rank, signature and badges to the author card.

#### Scenario: Paging
- **WHEN** a topic has 45 posts and the page size is 20
- **THEN** it has 3 pages, and page 3 shows posts 41–45

### Requirement: Locked topics
A locked topic SHALL reject new replies from members without the lock moderator power, and SHALL show a locked indicator.

#### Scenario: Reply to locked topic
- **WHEN** a member without moderator powers replies to a locked topic
- **THEN** the reply is rejected, and the reply editor is not shown

### Requirement: Moved-topic stubs
When moving a topic, the system SHALL let the moderator choose to leave a redirect stub in the original forum for a chosen number of days.

#### Scenario: Stub redirects
- **WHEN** a member opens a moved-topic stub
- **THEN** they are redirected to the topic in its new forum

### Requirement: View counts
Each topic view, by members or guests (including views served from the CDN), SHALL increase the view count, counted at most once per viewer per topic per 30 minutes. View counts MAY lag by up to 2 minutes.

#### Scenario: Repeat view
- **WHEN** the same member reloads a topic 5 times within 10 minutes
- **THEN** the view count increases by 1

#### Scenario: Guest view counted
- **WHEN** a guest opens a topic served from the CDN cache
- **THEN** the view count increases by 1 within 2 minutes

### Requirement: Topic URLs
Topics SHALL have URLs of the form `/topic/<id>-<slug>`, with pages at `/topic/<id>-<slug>/page/<n>` and posts at `/topic/<id>-<slug>/post/<postId>`. They SHALL be resolved by ID only, and missing or outdated slugs SHALL permanently redirect.

#### Scenario: Retitled topic
- **WHEN** a topic is retitled and its old URL is requested
- **THEN** the response is a 301 to the new slug
