import { loadConfig } from "./config.ts";
import { loadSigningKey } from "./key.ts";
import { createMockHandler } from "./server.ts";

const configPath = Bun.env.DARKAUTH_MOCK_CONFIG ?? "darkauth-mock.yaml";
const dataDir = Bun.env.DARKAUTH_MOCK_DATA_DIR ?? "/data";
const config = await loadConfig(configPath);
const key = await loadSigningKey(dataDir);
const port = Number(Bun.env.PORT ?? config.port);

Bun.serve({
  hostname: config.host,
  port,
  fetch: createMockHandler({ config, key }),
});

console.log(`mock-darkauth listening on ${config.host}:${port} (issuer ${config.issuer})`);
