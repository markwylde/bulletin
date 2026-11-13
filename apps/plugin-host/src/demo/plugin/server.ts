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

const client = await connectBroker(socketPath, { pluginId, sdkVersion: "0.0.0" });

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
