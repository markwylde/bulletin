import { type BrokerClient, definePlugin, servePlugin } from "@bulletin/plugin-sdk";

let broker: BrokerClient | undefined;

async function greet(memberId: string): Promise<void> {
  if (broker === undefined) {
    return;
  }

  await broker.call("db.query", {
    sql: "INSERT INTO greetings (member_id, greeting) VALUES ($1, $2)",
    params: [memberId, "Welcome aboard!"],
  });
}

const plugin = definePlugin({
  id: "welcome-bot",
  version: "1.0.0",
  hooks: {},
  events: {
    "member.created": async (event) => {
      const memberId = event.payloadIds.memberId;

      if (memberId !== undefined) {
        await greet(memberId);
      }
    },
  },
  jobs: {
    digest: async () => {
      if (broker !== undefined) {
        await broker.call("db.query", {
          sql: "SELECT count(*) AS count FROM greetings",
        });
      }
    },
  },
});

const server = await servePlugin(plugin, {
  socketPath: process.env.PLUGIN_SOCKET ?? "/run/broker.sock",
});
broker = server.client;
