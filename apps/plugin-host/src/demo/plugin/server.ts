/**
 * The sandbox demo plugin. It runs inside nsjail and talks to the broker only over
 * the Unix socket: a JSON-RPC handshake, then a couple of database calls and a log line.
 *
 * If the broker is not available (for example the sandbox-only measurement harness), the
 * calls fail and are reported on stderr; the plugin stays alive so the supervisor can measure
 * it.
 */
import { connectBroker } from "./rpc.ts";

const pluginId = process.env.PLUGIN_ID;
const socketPath = process.env.PLUGIN_SOCKET;

if (pluginId === undefined || socketPath === undefined) {
  throw new Error("PLUGIN_ID and PLUGIN_SOCKET are required");
}

interface QueryResult {
  readonly rows: Array<Record<string, unknown>>;
}

const client = await connectBroker(socketPath, { pluginId, sdkVersion: "2.0.0" });

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

client.onRequest(async ({ method, params }) => {
  const input = record(params);

  switch (method) {
    case "hook.enrich":
      return { fields: { tipTotal: 5 }, tags: ["tips"] };
    case "hook.filter":
      return { content: String(input.content ?? "").replaceAll("teh", "the") };
    case "hook.veto":
      return String(input.content ?? "").includes("blocked by demo")
        ? { allow: false, reasonKey: "plugin.demo.veto" }
        : { allow: true };
    case "content.extend":
      return { html: `<span class="bl-tip-demo">${String(input.source ?? "")}</span>` };
    case "route.request":
    case "bridge.request": {
      const viewer = record(input.viewer);
      return {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: `viewer:${typeof viewer.memberId === "string" ? viewer.memberId : "guest"}`,
      };
    }
    case "event.deliver":
      await client.call("log", {
        level: "info",
        message: "demo plugin received an event",
        fields: { type: input.type },
      });
      return null;
    case "job.run":
      await client.call("log", {
        level: "info",
        message: "demo plugin ran a job",
        fields: { name: input.name },
      });
      return null;
    default:
      throw new Error(`Unknown hook method: ${method}`);
  }
});

try {
  const inserted = await client.call<QueryResult>("db.query", {
    sql: "INSERT INTO notes (body) VALUES ($1) RETURNING id",
    params: ["hello from the sandbox"],
  });
  const id = inserted.rows[0]?.id;

  const recent = await client.call<QueryResult>("db.query", {
    sql: "SELECT id, body FROM notes ORDER BY id DESC LIMIT 5",
  });

  await client.call("log", {
    level: "info",
    message: "demo plugin exercised the broker",
    fields: { insertedId: id, recentRows: recent.rows.length },
  });
} catch (error) {
  console.error(`broker demo failed: ${error instanceof Error ? error.message : String(error)}`);
}

// Keep the plugin alive until the supervisor stops the sandbox.
await new Promise(() => {});
