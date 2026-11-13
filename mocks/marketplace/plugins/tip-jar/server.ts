import { definePlugin, servePlugin } from "@bulletin/plugin-sdk";

const plugin = definePlugin({
  id: "tip-jar",
  version: "1.0.0",
  hooks: {},
  routes: {
    tip: () => ({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }),
  },
});

await servePlugin(plugin, { socketPath: process.env.PLUGIN_SOCKET ?? "/run/broker.sock" });
