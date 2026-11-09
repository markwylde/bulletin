import { createLogger, loadConfig, parseReplicas } from "@bulletin/config";
import {
  createDatabaseCheck,
  createListenerCheck,
  createServiceSql,
  startService,
} from "@bulletin/config/server";
import { migrationsCurrent, runMigrations } from "@bulletin/db/migrate";
import { runBaseSeed } from "@bulletin/db/seed";
import { createAuthRouter, createSessionStore } from "@bulletin/domain/auth";

const config = loadConfig();
const logger = createLogger({ service: "staff-api", level: config.logLevel });
const port = config.port;
const databaseUrl = config.databaseUrl;
const migrationUrl = Bun.env.MIGRATION_DATABASE_URL ?? databaseUrl;

await runMigrations({ databaseUrl: migrationUrl });
await runBaseSeed({ databaseUrl: migrationUrl, seed: config.seed, size: config.seedSize });

const sql = createServiceSql("staff-api", databaseUrl);
const listener = await createListenerCheck(sql);
const sessions = await createSessionStore({ sql });
const auth = createAuthRouter({
  sql,
  kind: "staff",
  issuer: config.authIssuer,
  jwksUrl: config.authJwksUrl,
  clientId: config.authStaffClientId,
  origin: config.staffOrigin,
  sessionSecret: config.sessionSecret,
  nodeEnv: config.nodeEnv,
  bootstrapAdmins: config.bootstrapAdmins,
  sessions,
});

await startService({
  service: "staff-api",
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
    service: "staff-api",
    replicas: parseReplicas(Bun.env.BULLETIN_REPLICAS),
  },
  async onShutdown() {
    await sessions.close();
    await listener.close();
    await sql.close();
  },
}).catch(async (error: unknown) => {
  await sessions.close();
  await listener.close();
  await sql.close();
  throw error;
});

logger.info("service listening", { port });
