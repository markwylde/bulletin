import { createLogger, loadConfig, parseReplicas } from "@bulletin/config";
import {
  createDatabaseCheck,
  createListenerCheck,
  createServiceSql,
  startService,
} from "@bulletin/config/server";
import { migrationsCurrent, runMigrations } from "@bulletin/db/migrate";
import { runBaseSeed } from "@bulletin/db/seed";
import { createAuthRouter } from "@bulletin/domain/auth";

const config = loadConfig();
const logger = createLogger({ service: "user-api", level: config.logLevel });
const port = config.port;
const databaseUrl = config.databaseUrl;
const migrationUrl = Bun.env.MIGRATION_DATABASE_URL ?? databaseUrl;

await runMigrations({ databaseUrl: migrationUrl });
await runBaseSeed({ databaseUrl: migrationUrl, seed: config.seed, size: config.seedSize });

const sql = createServiceSql("user-api", databaseUrl);
const listener = await createListenerCheck(sql);
const auth = createAuthRouter({
  sql,
  kind: "user",
  issuer: config.authIssuer,
  jwksUrl: config.authJwksUrl,
  clientId: config.authUserClientId,
  origin: config.userOrigin,
  sessionSecret: config.sessionSecret,
  nodeEnv: config.nodeEnv,
});

await startService({
  service: "user-api",
  logger,
  port,
  async fetch(request) {
    return (await auth(request)) ?? Response.json({ code: "not_found" }, { status: 404 });
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
  async onShutdown() {
    await listener.close();
    await sql.close();
  },
}).catch(async (error: unknown) => {
  await listener.close();
  await sql.close();
  throw error;
});

logger.info("service listening", { port });
