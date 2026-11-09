# Spec Delta

## Purpose

Makes public discussions discoverable and followable from outside the board, without
exposing anything that isn't public.

## ADDED Requirements

### Requirement: Sitemaps of public content
The board SHALL serve a sitemap index and paginated sitemaps listing guest-readable forums, topics (with last-modified dates) and member profiles (if profiles are public). Non-public content SHALL never appear.

#### Scenario: Staff forum excluded
- **WHEN** a search engine fetches the sitemaps
- **THEN** no URL from a forum guests cannot read is listed

### Requirement: Feeds
The board SHALL provide RSS and Atom feeds of recent topics for the whole board and per forum. Feeds SHALL include only guest-visible, approved, non-deleted content, using quote-free text excerpts.

#### Scenario: Forum feed
- **WHEN** a feed reader requests a public forum's feed
- **THEN** it receives the 20 most recent topics with title, link, author, date and excerpt

#### Scenario: Private forum feed
- **WHEN** a feed for a forum guests cannot read is requested
- **THEN** the response is 404

### Requirement: Page metadata
Every public page SHALL have a unique title, a description, a canonical URL, and OpenGraph and Twitter card tags. Topic pages SHALL include discussion structured data. Locale variants SHALL be linked with `hreflang`.

#### Scenario: Canonical on paged topic
- **WHEN** page 2 of a topic is requested with extra query parameters
- **THEN** its canonical URL is the clean URL of page 2

### Requirement: Indexing controls
Pages not visible to guests, search results, member lists and staff pages SHALL be marked `noindex`. Admins SHALL edit `robots.txt` from the staff app.

#### Scenario: Search page
- **WHEN** a search results page is requested
- **THEN** it carries a `noindex` directive

### Requirement: Feed and sitemap caching
Sitemaps and feeds SHALL be served from the CDN cache and SHALL reflect changes within the guest revocation window.

#### Scenario: Topic made private
- **WHEN** a topic's forum becomes members-only
- **THEN** it disappears from feeds and sitemaps within 30 seconds
