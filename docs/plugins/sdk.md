# SDK guide

Import the public package only: `@bulletin/plugin-sdk` (manifest, hooks, runtime) and
`@bulletin/plugin-sdk/bridge` for iframe client apps. The SDK is semver'd; the host runs the
current major and one previous major through shims.

## Manifest (`plugin.json`)

Required: `id`, `name`, `version`, `sdkVersion`, `entry`. Optional: `capabilities`,
`egressHosts`, `migrations`, `templateFragments`, `enrichers`, `filters`, `vetoes`, `events`,
`contentExtensions`, `routes`, `jobs`, `clientApps`, `settings`, `forumActions`, `flags`,
`personalData`, `i18n`.

IDs are 1–49 lowercase letters/digits/hyphens. `sdkVersion` is a semver range (`^2.0.0`).
Migrations are relative `.sql` files; `clientApps` entries are relative paths inside the
bundle. `personalData` declares every table holding member data.

## Server

```ts
import { definePlugin, servePlugin } from "@bulletin/plugin-sdk";

const plugin = definePlugin({
  id: "welcome-bot",
  version: "1.0.0",
  hooks: {
    enrichers: {
      "topic.view": {
        fields: ["tipTotal"],
        deps: ["tips"],
        handler: () => ({ fields: { tipTotal: 5 }, tags: ["tips"] }),
      },
    },
    filters: { "post.write": { handler: ({ content }) => content } },
    vetoes: {
      "post.write": { reasonKey: "plugin.spam.reason", handler: () => ({ allow: true }) },
    },
  },
  events: { "member.created": () => undefined },
  jobs: { digest: () => undefined },
  routes: { tip: () => ({ status: 200, body: "{}" }) },
  contentExtensions: { tip: () => ({ html: "<span>tip</span>" }) },
  gdpr: {
    export: ({ memberId }) => ({ data: { memberId } }),
    erase: () => undefined,
  },
});

await servePlugin(plugin, { socketPath: process.env.PLUGIN_SOCKET! });
```

The broker socket is the only I/O channel. Use the SDK client (`db.query`, `core.call`,
`http.fetch`, `cache.invalidate`, job/kv helpers); never open a socket or read the environment.

## Versioning

- `SDK_VERSION` is `2.0.0`. A `^1.x` plugin loads through one-major shims and the staff manager
  marks it deprecated.
- Hook names retired in the previous major are translated by the shim (for example
  `post.enrich` → `post.view.enrich`).
- A future major requires a new bundle build; downgrades are not supported.
