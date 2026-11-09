import { loadConfig } from "@bulletin/config";
import { startService } from "@bulletin/config/server";

const config = loadConfig();

await startService({
  service: "plugin-host",
  port: config.port,
  fetch() {
    return Response.json({ service: "plugin-host", status: "ok" });
  },
  checks: [],
});

console.log(`plugin-host listening on http://localhost:${config.port}`);
