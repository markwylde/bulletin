# ui-rebuild — tasks

## 0. Foundations
- [ ] 0.1 ADR 0021 and this change
- [ ] 0.2 `scripts/ui-shots.ts` (page list, viewports 360/768/1440, light/dark, guest/member/admin) and `scripts/ui-hooks.ts` (data-* hook diff vs main)
- [ ] 0.3 Add `tablet: 768x1024` to test-utils VIEWPORTS
- [ ] 0.4 Self-host Inter (user-app `/fonts/`, staff-app bundle), licence file included

## 1. User shell (track U)
- [ ] 1.1 Delete `default.css` and rewrite tokens; base, layout, typography, buttons, forms, badges, panels, lists, tables, pagination, alerts
- [ ] 1.2 Header: brand, primary nav, search, member area (notifications, messages, avatar menu), guest sign-in; mobile menu
- [ ] 1.3 Breadcrumbs in every view model plus the page-header pattern; mobile "‹ parent"
- [ ] 1.4 Footer: language, scheme/theme choosers, links; remove them from the header
- [ ] 1.5 Empty, error, offline and not-found states

## 2. User reading pages (track U)
- [ ] 2.1 Board index: category panels with forum rows, unread markers, last post with avatar, stats and who's-online footer block
- [ ] 2.2 Forum: header, rules, announcements, subforums, prefix filter, topic list rows, pagination, bulk moderation bar
- [ ] 2.3 Topic and post: author column, post body typography, signatures, reactions, poll, attachments, quick reply editor, mod tools
- [ ] 2.4 Search, profile, members/online, leaderboards

## 3. User member and moderation pages (track U)
- [ ] 3.1 Account area with a side nav (profile, notifications, preferences, privacy, attachments, follows, API keys, warnings)
- [ ] 3.2 Conversations list and thread
- [ ] 3.3 Moderation queue, reports, report detail, log, warnings
- [ ] 3.4 Login/callback, display-name, privacy policy, unsubscribe, api-docs, demo, plugin
- [ ] 3.5 Islands restyled (Editor, Reactions, PostReputation, choosers, LocaleSuggestion, FeedLinks, PluginApp, ApiDocs)
- [ ] 3.6 Re-base seeded demo/VIP themes on the new default; add the "Lounge" card theme

## 4. Staff shell (track S)
- [ ] 4.1 Delete `styles.css`; tokens, base and the kit in `src/ui/`
- [ ] 4.2 `sections.ts` areas and groups; rail, panel, mobile drawer, breadcrumbs, top bar, section search, account menu
- [ ] 4.3 Dashboard rebuilt

## 5. Staff pages (track S)
- [ ] 5.1 Members area: member profiles, groups, group settings, permissions, ranks, badges, profile fields, reputation, promotions
- [ ] 5.2 Forums & content: forums, prefixes, announcements, emoticons, reactions, filters
- [ ] 5.3 Moderation: moderation, bans, warnings, multimod, moderators, moderation log
- [ ] 5.4 Appearance: themes (editor and diff), string overrides; Integrations: plugins, webhooks, API keys, flags
- [ ] 5.5 Privacy and System: retention, policy, requests, PII log, admin log, health, missing files, dead letters, board settings

## 6. Polish and gate
- [x] 6.1 Full shot review at 3 viewports × 2 schemes; fix spacing, alignment and overflow
- [x] 6.2 E2E: breadcrumbs, staff nav, overflow at 360; full suite green
- [x] 6.3 After screenshots saved for the part 2 post
- [x] 6.4 Gate: `bun run i18n:build && bun run check`, `BULLETIN_INTEGRATION=1 bun run test:integration` (CI's "Compose database/integration tests") and the full `bun scripts/run-e2e.ts`; every phase gate runs all three
