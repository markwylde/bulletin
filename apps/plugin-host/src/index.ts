import { createLogger, loadConfig } from "@bulletin/config";
import { startService } from "@bulletin/config/server";

const config = loadConfig();
const logger = createLogger({ service: "plugin-host", level: config.logLevel });

await startService({
  service: "plugin-host",
  logger,
  port: config.port,
  fetch() {
    return Response.json({ service: "plugin-host", status: "ok" });
  },
  checks: [],
});

logger.info("service listening", { port: config.port });
