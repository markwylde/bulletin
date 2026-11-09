# Architecture Decision Records

These ADRs are binding for every implementing agent and human. If a change needs to
contradict one, write a new ADR that supersedes it first; never silently diverge.

Format: `NNNN-kebab-title.md` with **Status / Context / Decision / Consequences**.

| # | Title |
|---|-------|
| 0001 | [Monorepo layout and Bun-first tooling](0001-monorepo-and-bun-first.md) |
| 0002 | [Local development: clone, then `docker compose up --watch`](0002-local-dev-two-steps.md) |
| 0003 | [Postgres is the only stateful dependency](0003-postgres-only-state.md) |
| 0004 | [Identity via DarkAuth, authorisation in Bulletin](0004-identity-darkauth-authz-local.md) |
| 0005 | [Groups, permission masks and moderators](0005-groups-permission-masks.md) |
| 0006 | [Caching strategy](0006-caching-strategy.md) |
| 0007 | [Content pipeline: Markdown, WYSIWYG, sanitised HTML](0007-content-pipeline.md) |
| 0008 | [Themes and templates (user app only)](0008-themes-and-templates.md) |
| 0009 | [Plugin platform](0009-plugin-platform.md) |
| 0010 | [Feature flags](0010-feature-flags.md) |
| 0011 | [Background work, events and realtime](0011-jobs-events-realtime.md) |
| 0012 | [Privacy, PII and GDPR](0012-privacy-pii-gdpr.md) |
| 0013 | [Internationalisation](0013-i18n.md) |
| 0014 | [Mobile-first and PWA](0014-mobile-pwa.md) |
| 0015 | [Testing strategy](0015-testing.md) |
| 0016 | [Public API, API keys and webhooks](0016-public-api-webhooks.md) |
| 0017 | [Search on Postgres full-text](0017-search.md) |
| 0018 | [Authentication, sessions and origin topology](0018-auth-sessions-origins.md) |
| 0019 | [Storage, attachments and avatars](0019-storage-attachments.md) |
| 0020 | [Operations: backups, health, observability, capacity](0020-operations.md) |

## Spikes required before feature work
- **S1** — runtime Liquid templates + island hydration inside Astro, adapter choice (ADR 0008).
  Change `rendering-and-caching`, built before `forum-structure` on a dev-only demo route.
- **S2** — nsjail plugin sandbox + broker + malicious-plugin suite under Docker and Podman (ADR 0009).
  Change `plugin-sandbox-spike`, straight after `foundation-dev-environment`.

Record each spike's outcome in its ADR and flip its status to Accepted.

Product scope (what is in/out) lives in [`../features.md`](../features.md).
