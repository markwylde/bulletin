import { definePlugin, servePlugin } from "@bulletin/plugin-sdk";

/**
 * The sample event handler is intentionally small; a real plugin would use the broker's
 * `core.*` and `db.query` calls documented in `docs/plugins/sdk.md`.
 */
const plugin = definePlugin({
  id: "welcome-bot",
  version: "1.0.0",
  hooks: {},
  events: {
    "member.created": () => undefined,
  },
  jobs: {
    digest: () => undefined,
  },
});

await servePlugin(plugin, { socketPath: process.env.PLUGIN_SOCKET ?? "/run/broker.sock" });
