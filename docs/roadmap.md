# Roadmap: OpenSpec changes in build order

Each row is an OpenSpec change in `openspec/changes/<name>/` (proposal, specs, design, tasks).
Build them in order. A change may start only once the changes it depends on are archived.
Architecture is fixed by `docs/adr/`; product scope by `docs/features.md`.

| # | Change | Capabilities | Depends on | ADRs |
|---|--------|--------------|------------|------|
| 1 | `foundation-dev-environment` | dev-environment, local-mocks, service-health | — | 0001 0002 0003 0015 0018 0020 |
| 2 | `i18n-foundation` | i18n | 1 | 0013 |
| 3 | `identity-sessions` | auth-sessions, member-identity | 1, 2 | 0004 0012 0018 |
| 4 | `staff-console-shell` | staff-console | 3 | 0014 0018 |
| 5 | `feature-flags` | feature-flags | 4 | 0010 |
| 6 | `groups-permissions` | groups, forum-permissions, moderator-assignments | 5 | 0005 |
| 7 | `forum-structure` | forums, announcements | 6 | 0005 |
| 8 | `rendering-and-caching` (spike S1) | page-rendering, caching | 7 | 0006 0008 |
| 9 | `content-pipeline` | content-rendering, post-editor | 8 | 0007 |
| 10 | `topics-posts` | topics, posts, polls, read-tracking | 9 | 0005 0006 0007 |
| 11 | `attachments-avatars` | attachments, avatars | 10 | 0019 |
| 12 | `events-notifications` | domain-events, notifications, follows, realtime-stream | 10 | 0011 |
| 13 | `reactions-reputation` | reactions, reputation | 12 | 0005 |
| 14 | `member-profiles` | member-profiles, member-relationships, member-directory, ranks-badges | 13 | 0005 0012 |
| 15 | `conversations` | conversations | 12, 14 | 0011 |
| 16 | `moderation` | moderation-queue, reports, topic-moderation, warnings, content-filters, ip-bans, moderation-log | 10, 15 | 0005 0012 |
| 17 | `search` | search | 10 | 0017 |
| 18 | `themes` | themes | 8 | 0008 |
| 19 | `plugin-platform` (spike S2) | plugin-lifecycle, plugin-sandbox, plugin-hooks, plugin-admin-forms | 12, 18 | 0009 |
| 20 | `privacy-gdpr` | privacy | 16, 19 | 0012 |
| 21 | `public-api-webhooks` | public-api, webhooks | 12 | 0016 |
| 22 | `pwa-push` | pwa, web-push | 12 | 0014 |
| 23 | `seo-feeds` | seo-feeds | 10 | 0006 |
| 24 | `operations-observability` | observability, backups | 1 | 0020 |

Conventions every change follows (enforced through `openspec/config.yaml` rules):
- Ships behind a feature flag (once change 5 exists), with en/es/fr strings and seed data.
- Lands its own tests per ADR 0015, including permission-denial and cache-variant tests.
- Is mobile-first (360 px) for every screen it adds.
