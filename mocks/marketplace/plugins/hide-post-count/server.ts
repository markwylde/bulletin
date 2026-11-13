import { definePlugin, servePlugin } from "@bulletin/plugin-sdk";

/** No server hooks: this sample only overrides the post-userbar template fragment. */
const plugin = definePlugin({ id: "hide-post-count", version: "1.0.0", hooks: {} });

await servePlugin(plugin, { socketPath: process.env.PLUGIN_SOCKET ?? "/run/broker.sock" });
