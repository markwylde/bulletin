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
| `topic-notice` | a marketplace install from the staff console (not seeded) |

The demo seed installs `hide-post-count` disabled and `welcome-bot` and `tip-jar` active, and
leaves `topic-notice` in the marketplace for staff to install. The marketplace compiles each
sample's `server.ts` with the SDK into one file, because the jail has no `node_modules`.

## Install and runtime

plugin-host runs every installed and enabled plugin, each in its own nsjail sandbox with its own
broker, schema, egress allow-list and quota monitor, plus the local demo bundle
(`PLUGIN_HOST_BUNDLE`). `core.plugins` is the desired state:

1. Staff open **Plugins → Marketplace** and choose **Review**. staff-api downloads the bundle,
   checks its sha256 against the signed catalog and its detached signature, and shows the
   capabilities and egress hosts the manifest asks for.
2. **Approve and install** (step-up required) sends exactly that list back. staff-api refuses an
   approval that differs from the manifest, stores the verified bundle, checksum and signature
   in `core.plugins` as `installing`, journals the request and sends `NOTIFY bulletin_plugins`.
3. plugin-host reconciles on the NOTIFY, on LISTEN reconnects and every
   `PLUGIN_HOST_RECONCILE_INTERVAL_MS` (30 s). It re-checks the stored bundle's sha256, unpacks
   it, runs its migrations, starts the sandbox, publishes fragments and registry rows, bumps
   `pluginsGeneration` and moves the row to `active`, or to `failed` with the error.
4. Disable, uninstall and the circuit breaker update the row and notify; plugin-host stops the
   sandbox. **Enable** moves a disabled or failed plugin back to `installing`.

A seeded row without a stored bundle is fetched from the signed marketplace on first start.
