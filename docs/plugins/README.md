# Bulletin plugins

Plugins are signed bundles that add hooks, routes, jobs, settings and sandboxed client apps
without forking the board. The platform contract is [ADR 0009](../adr/0009-plugin-platform.md).

## Guides

- [SDK guide](sdk.md) — manifest, `definePlugin`, broker APIs and versioning.
- [Hook reference](hooks.md) — fragments, enrichers, filters, vetoes, events, content, routes, jobs.
- [Capabilities](capabilities.md) — what each requested capability allows and how review works.
- [Sandbox limits](sandbox-limits.md) — nsjail, cgroups, seccomp and database budgets.

## Samples

Source bundles live in [`mocks/marketplace/plugins/`](../../mocks/marketplace/plugins) and are
published by the local marketplace mock:

| Plugin | Demonstrates |
|---|---|
| `hide-post-count` | template fragment override (seeded disabled) |
| `welcome-bot` | event subscriber, job, settings form and its own schema |
| `tip-jar` | iframe client app, plugin route, forum action, flag and own schema |

The seed installs `hide-post-count` disabled and the other two active. Local development runs
one demo sandbox; sample bundles are served for their static client apps and their registry
rows exercise the manager, settings and matrix UI.
