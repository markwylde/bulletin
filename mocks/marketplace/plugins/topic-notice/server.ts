import { definePlugin, servePlugin } from "@bulletin/plugin-sdk";

/**
 * No server hooks: this sample's fragment takes over the demo topic list's hook point from the
 * seed's stand-in. It is published but not seeded, so staff can try a marketplace install.
 */
const plugin = definePlugin({ id: "topic-notice", version: "1.0.0", hooks: {} });

await servePlugin(plugin, { socketPath: process.env.PLUGIN_SOCKET ?? "/run/broker.sock" });
