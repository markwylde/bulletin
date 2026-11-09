# Roadmap: OpenSpec changes in build order

Each row is an OpenSpec change in `openspec/changes/<name>/` (proposal, specs, design, tasks).
Build them in order. Both spikes run early: S2 straight after the foundation, and S1 before
the first feature page, so no feature is built on unproven architecture. A change may start only once the changes it depends on are archived.
Architecture is fixed by `docs/adr/`; product scope by `docs/features.md`.

| # | Change | Capabilities | Depends on | ADRs |
|---|--------|--------------|------------|------|
| 1 | `foundation-dev-environment` | dev-environment, local-mocks, service-health | — | 0001 0002 0003 0015 0018 0020 |
| 2 | `plugin-sandbox-spike` (spike S2) | — (spike, `skip_specs`) | `foundation-dev-environment` | 0009 |
| 3 | `i18n-foundation` | i18n | `foundation-dev-environment` | 0013 |
| 4 | `identity-sessions` | auth-sessions, member-identity | `foundation-dev-environment`, `i18n-foundation` | 0004 0012 0018 |
| 5 | `staff-console-shell` | staff-console | `identity-sessions` | 0014 0018 |
| 6 | `feature-flags` | feature-flags | `staff-console-shell` | 0010 |
| 7 | `groups-permissions` | groups, forum-permissions, moderator-assignments | `feature-flags` | 0005 |
| 8 | `rendering-and-caching` (spike S1) | page-rendering, caching | `groups-permissions` | 0006 0008 |
| 9 | `forum-structure` | forums, announcements | `rendering-and-caching` | 0005 0006 |
| 10 | `content-pipeline` | content-rendering, post-editor | `forum-structure` | 0007 |
| 11 | `topics-posts` | topics, posts, polls, read-tracking | `content-pipeline` | 0005 0006 0007 |
| 12 | `attachments-avatars` | attachments, avatars | `topics-posts` | 0019 |
| 13 | `events-notifications` | domain-events, notifications, follows, realtime-stream | `topics-posts` | 0011 |
| 14 | `reactions-reputation` | reactions, reputation | `events-notifications` | 0005 |
| 15 | `member-profiles` | member-profiles, member-relationships, member-directory, ranks-badges | `reactions-reputation` | 0005 0012 |
| 16 | `conversations` | conversations | `events-notifications`, `member-profiles` | 0011 |
| 17 | `moderation` | moderation-queue, reports, topic-moderation, warnings, content-filters, ip-bans, moderation-log | `topics-posts`, `conversations` | 0005 0012 |
| 18 | `search` | search | `topics-posts` | 0017 |
| 19 | `themes` | themes | `rendering-and-caching` | 0008 |
| 20 | `plugin-platform` | plugin-lifecycle, plugin-sandbox, plugin-hooks, plugin-admin-forms | `plugin-sandbox-spike`, `events-notifications`, `themes` | 0009 |
| 21 | `privacy-gdpr` | privacy | `moderation`, `plugin-platform` | 0012 |
| 22 | `public-api-webhooks` | public-api, webhooks | `events-notifications` | 0016 |
| 23 | `pwa-push` | pwa, web-push | `events-notifications`, `themes` | 0014 |
| 24 | `seo-feeds` | seo-feeds | `topics-posts` | 0006 |
| 25 | `operations-observability` | observability, backups | `rendering-and-caching`, `events-notifications`, `plugin-platform` | 0020 |

Conventions every change follows (enforced through `openspec/config.yaml` rules):
- Ships behind its named feature flag (once `feature-flags` exists; the key is in each design), except core reading and posting, and comes with en/es/fr strings and seed data.
- Lands its own tests per ADR 0015, including permission-denial and cache-variant tests.
- Is mobile-first (360 px) for every screen it adds.
