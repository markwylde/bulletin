# Hook reference

| Hook | Type | Contract |
|---|---|---|
| `templateFragments` | compile time | `name`, `kind` (`hook`/`override`), Liquid body, optional cache `deps`. Fragments follow theme safety rules and compile per `pluginsGeneration`. |
| `enrichers` | request (100 ms) | Declared `fields`, dependency `deps`; return only declared fields and namespaced tags. Timeout leaves fields empty. |
| `filters` | write path | Ordered by `priority`; total plugin budget 300 ms. A failure/timeout skips that filter (fail-open). |
| `vetoes` | write path | Requires the `veto` capability; returns `allow` + translated `reasonKey`. Defaults fail-open; admins can choose fail-closed. |
| `events` | async | One `plugin.<id>.events` queue per plugin; each event is delivered independently with IDs only. |
| `contentExtensions` | write time | Registered syntax returns HTML; the core sanitiser always runs afterwards. |
| `routes` | request | `page` routes render under `/p/<plugin>/…` through the theme; `api` routes under `/api/p/<plugin>/…`. |
| `jobs` | async | Queued/scheduled on `plugin.<id>.<name>`; retries land in a dead letter. |
| `settings` | staff | Form DSL definition, rendered by core components. May declare a core `extensionPoint` such as `acp.groups.settings`. |
| `clientApps` | iframe | Static app on the plugin origin, framed with `sandbox="allow-scripts allow-forms"` and a per-frame message bridge. |
| `gdpr` | maintenance | `export`/`erase` handlers run in the active or maintenance sandbox. A failure keeps the request open. |

## Hooks placed by the default theme

`post.userbar`, `post.after.body`, `demo.after.topics`. Plugin fragments may replace a named
theme template via `kind: "override"`; the theme's own version remains the fallback.

## Cache tags

Plugin enrichers/fragments declare `deps`; the broker exposes
`cache.invalidate(["leaderboard"])`, which always writes `plugin:<id>:leaderboard`. A plugin
cannot invalidate core or another plugin's tags.
