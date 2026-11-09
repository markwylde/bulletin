# Spec Delta

## Purpose

Turns what members write into safe, consistent HTML and plain text, once at write time, so
reading is fast and nothing a member writes can attack another member.

## ADDED Requirements

### Requirement: Markdown is the stored format
User content SHALL be stored as markdown (CommonMark with tables, task lists, strikethrough and autolinks). BBCode SHALL NOT be interpreted.

#### Scenario: BBCode left as text
- **WHEN** a member writes `[b]hi[/b]`
- **THEN** it displays literally as `[b]hi[/b]`

### Requirement: Sanitised HTML output
Rendered HTML SHALL contain only allowlisted elements, attributes and URL schemes for its profile. Links SHALL carry `rel="nofollow ugc noopener"`. No script, style attribute or event handler SHALL ever be output.

#### Scenario: Script injection
- **WHEN** a post contains raw HTML `<img src=x onerror=alert(1)>`
- **THEN** the stored HTML contains no `onerror` attribute, and no script runs when viewed

#### Scenario: Signature profile
- **WHEN** a signature contains a heading and a table
- **THEN** they are rendered according to the stricter signature profile (headings downgraded, tables removed)

### Requirement: Render once at write time
On save, content SHALL be rendered to HTML and to plain text, and both stored with the markdown. Reading SHALL NOT re-render markdown.

#### Scenario: Edit re-renders
- **WHEN** a post is edited
- **THEN** its stored HTML and plain text reflect the edit immediately

### Requirement: Sanitiser upgrades apply to old content
When the sanitiser rules change, content rendered under older rules SHALL be re-sanitised before being served, until a background job has re-rendered it.

#### Scenario: Emergency fix
- **WHEN** a sanitiser fix is deployed with a new sanitiser version
- **THEN** old posts served after deployment pass through the new rules, even before the re-render job reaches them

### Requirement: Mentions
`@DisplayName` SHALL link to the member's profile when the member exists, and SHALL be recorded for notifications. Mentions of members who cannot read the content SHALL NOT notify them.

#### Scenario: Mention renders
- **WHEN** a post mentions an existing member
- **THEN** it renders as a link to their profile

### Requirement: Emoticons
`:code:` SHALL render as the matching staff-defined emoticon image with alt text. Unknown codes SHALL remain as text.

#### Scenario: Known emoticon
- **WHEN** a post contains `:smile:` and that emoticon exists
- **THEN** it renders as the smile image with alt text "smile"

### Requirement: Quotes resolved per viewer
A quote SHALL reference a source post the author could read when posting, or the save SHALL be rejected. Quote text SHALL be shown only to viewers who can currently read the non-deleted source, and others SHALL see "Quoted content unavailable".

#### Scenario: Quote of private post
- **WHEN** a staff member quotes a staff-forum post in a public topic
- **THEN** guests see "Quoted content unavailable", and staff see the quote

#### Scenario: Unauthorised quote
- **WHEN** a member submits a quote referencing a post they cannot read
- **THEN** the save is rejected

### Requirement: Quotes excluded from derived text
Plain text derived from content (used for search, previews, notifications, emails, push, webhooks and feeds) SHALL exclude quoted text.

#### Scenario: Search ignores quote
- **WHEN** a post quotes another post containing "zebra" and contains no "zebra" itself
- **THEN** searching "zebra" does not match the quoting post

### Requirement: Embeds and unfurls
Links from allowlisted providers (YouTube, Vimeo and others configured by admins) SHALL render as embedded players. Other standalone links SHALL render as preview cards once fetched. Fetching SHALL never target private or internal network addresses.

#### Scenario: Internal address blocked
- **WHEN** a post links to a URL resolving to `10.0.0.5`
- **THEN** no fetch is made, and the link renders as a plain link

#### Scenario: Preview card
- **WHEN** a post contains a standalone link to a public page with OpenGraph tags
- **THEN** after the fetch completes, the post shows a card with title, description and a proxied image

### Requirement: Emoticon management
Staff with `acp.emoticons` SHALL manage emoticon sets: upload images, set codes and alt text, order them, and choose which sets appear in the editor.

#### Scenario: Duplicate code
- **WHEN** staff add an emoticon with a code already in use
- **THEN** the save is rejected
