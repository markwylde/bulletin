/**
 * The smallest possible plugin, used by the sandbox spike.
 *
 * It runs inside nsjail with an empty environment except for `PLUGIN_ID` and
 * `PLUGIN_SOCKET`, connects to the broker's Unix socket and announces itself. The supervisor
 * treats that handshake as proof that the jail, the socket mount and Bun all work.
 */
const pluginId = process.env.PLUGIN_ID;
const socketPath = process.env.PLUGIN_SOCKET;

if (pluginId === undefined || socketPath === undefined) {
  throw new Error("PLUGIN_ID and PLUGIN_SOCKET are required");
}

await Bun.connect({
  unix: socketPath,
  socket: {
    open(socket) {
      socket.write(`${JSON.stringify({ type: "hello", pluginId, sdkVersion: "0.0.0" })}\n`);
    },
    data() {
      // JSON-RPC calls arrive here once `plugin-platform` implements the broker protocol.
    },
    error(_socket, error) {
      console.error(`broker socket error: ${error.message}`);
    },
  },
});

// Keep the plugin alive until the supervisor stops the sandbox.
await new Promise(() => {});
