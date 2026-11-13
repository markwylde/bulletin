import { type BrokerClient, definePlugin, servePlugin } from "@bulletin/plugin-sdk";

let broker: BrokerClient | undefined;

const plugin = definePlugin({
  id: "tip-jar",
  version: "1.0.0",
  hooks: {},
  routes: {
    tip: async (request) => {
      const body =
        request.body === null ? {} : (JSON.parse(request.body) as Record<string, unknown>);
      const postId = typeof body.postId === "string" ? body.postId : "0";
      const amount = typeof body.amountCents === "number" ? body.amountCents : 100;

      if (broker !== undefined && request.viewer.memberId !== null) {
        await broker.call("db.query", {
          sql: "INSERT INTO tips (post_id, member_id, amount_cents) VALUES ($1, $2, $3)",
          params: [postId, request.viewer.memberId, amount],
        });
      }

      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, postId, amount }),
      };
    },
  },
});

const server = await servePlugin(plugin, {
  socketPath: process.env.PLUGIN_SOCKET ?? "/run/broker.sock",
});
broker = server.client;
