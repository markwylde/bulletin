# Bulletin — Product scope

A community forum in the spirit of Invision Power Board 1.x/2.x (the community app only).
Architecture lives in [`adr/`](adr/README.md). This file defines **what** we build.

## In scope

### Structure
- Categories → forums → unlimited-depth sub-forums
- Redirect/link forums (with click counter)
- Per-forum rules box above the topic list
- Password-protected forums (in addition to permissions)
- Topic prefixes/tags, configurable per forum
- Linear topic view only
- Pinned, locked, moved-topic redirect stubs, view counts, read/unread tracking
- Global and per-forum announcements

### Groups and permissions (ADR 0005)
- Primary and secondary groups; union of permissions
- IPB-style permission masks with a forum × mask matrix
- Group settings matrix: edit window, flood control, PM quota, upload quota, signature limits, etc.
- Auto-promotion between groups (post count, days registered, reputation)
- Per-forum moderators (members or groups) with granular powers; global super moderators
- No per-user overrides

### Posting
- Markdown WYSIWYG editor with sanitised output (ADR 0007); no BBCode
- Server-side draft autosave
- Polls (multiple questions, single or multiple choice)
- Attachments (S3)
- Post edit history (mods, optionally public)
- @mentions with notifications
- **Reactions and reputation** (both; each can be toggled per group)
- Staff-uploaded custom emoticon sets
- Link unfurls/embeds fetched by workers
- Multi-quote
- Soft delete with restore

### Notifications (ADR 0011)
- Follow topics, forums and members; in-app, email and push
- Daily/weekly email digests
- Live updates via SSE

### Members
- Multi-participant private conversations
- Staff-defined custom profile fields with group visibility
- Signatures with group-controlled limits
- Ignore/block members (hide posts, block PMs)
- Friends/follow members
- Forum display name separate from DarkAuth, with change history
- Member list, who's online, board stats on index
- Rank titles/pips by post count
- Badges: auto-awarded by rules plus manually granted
- Leaderboards (top posters, most reacted, by period)
- Avatars: upload with initials fallback (no Gravatar)
- Theme choice limited to themes the member's groups allow; light/dark/system

### Moderation
- Moderation queue for new members' first N posts (**optional, configured in the staff app**)
- Report centre for posts, members and PMs, with staff comments and status
- Merge, split and move topics; saved multi-moderation macros
- Warning points with auto-actions (mod queue, posting suspension, ban) and expiry
- Bad-word filter (replace or block)
- Poster IP logging and IP/range bans, GDPR compliant (ADR 0012)
- Link limits / anti-spam rules for new members
- Moderator action log

### Platform
- Postgres FTS search (ADR 0017)
- Full-template themes, user app only (ADR 0008); the staff app is fixed with light/dark mode
- Runtime-installed plugins from our marketplace, sandboxed (ADR 0009)
- Outbound webhooks and public API with keys (ADR 0016)
- Feature flags with group targeting and % rollout (ADR 0010)
- Slug URLs, sitemap.xml, RSS per forum
- i18n: en, es, fr (ADR 0013)
- PWA with push notifications (ADR 0014)
- GDPR: export, erasure, retention policies (ADR 0012)

## Out of scope
- Articles, blogs, downloads, gallery, calendar/events
- Q&A "best answer" forums (possible plugin)
- Threaded/tree topic view
- Per-forum "posts don't count" toggle
- Profile comments / status update feed
- Importers from vBulletin/IPB/phpBB
- Paid group subscriptions
- BBCode
