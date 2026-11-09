import { createLogger, loadConfig, parseReplicas } from "@bulletin/config";
import {
  createDatabaseCheck,
  createListenerCheck,
  createServiceSql,
  startService,
} from "@bulletin/config/server";
import { migrationsCurrent, runMigrations } from "@bulletin/db/migrate";
import { runBaseSeed } from "@bulletin/db/seed";

const config = loadConfig();
const logger = createLogger({ service: "user-api", level: config.logLevel });
const port = config.port;
const databaseUrl = config.databaseUrl;
const migrationUrl = Bun.env.MIGRATION_DATABASE_URL ?? databaseUrl;

await runMigrations({ databaseUrl: migrationUrl });
await runBaseSeed({ databaseUrl: migrationUrl, seed: config.seed, size: config.seedSize });

const sql = createServiceSql("user-api", databaseUrl);
const listener = await createListenerCheck(sql);

await startService({
  service: "user-api",
  logger,
  port,
  fetch() {
    return Response.json({ service: "user-api", status: "ok" });
  },
  checks: [
    createDatabaseCheck(sql),
    { name: "migrations", check: () => migrationsCurrent(sql) },
    listener,
  ],
  budget: {
    sql,
    service: "user-api",
    replicas: parseReplicas(Bun.env.BULLETIN_REPLICAS),
  },
  onShutdown: () => listener.close(),
}).catch(async (error: unknown) => {
  await listener.close();
  throw error;
});

logger.info("service listening", { port });
