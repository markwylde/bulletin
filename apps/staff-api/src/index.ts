import { createLogger, loadConfig, parseReplicas } from "@bulletin/config";
import {
  createDatabaseCheck,
  createListenerCheck,
  createServiceSql,
  startService,
} from "@bulletin/config/server";
import { migrationsCurrent, runMigrations } from "@bulletin/db/migrate";
import { runBaseSeed } from "@bulletin/db/seed";
import { createAuthService } from "@bulletin/domain/auth";
import { createStaffApi } from "./api.ts";

const config = loadConfig();
const logger = createLogger({ service: "staff-api", level: config.logLevel });
const port = config.port;
const databaseUrl = config.databaseUrl;
const migrationUrl = Bun.env.MIGRATION_DATABASE_URL ?? databaseUrl;

await runMigrations({ databaseUrl: migrationUrl });
await runBaseSeed({ databaseUrl: migrationUrl, seed: config.seed, size: config.seedSize });

const sql = createServiceSql("staff-api", databaseUrl);
const listener = await createListenerCheck(sql);
const auth = await createAuthService({
  sql,
  kind: "staff",
  issuer: config.authIssuer,
  jwksUrl: config.authJwksUrl,
  tokenUrl: config.authTokenUrl,
  clientId: config.authStaffClientId,
  origin: config.staffOrigin,
  sessionSecret: config.sessionSecret,
  nodeEnv: config.nodeEnv,
  bootstrapAdmins: config.bootstrapAdmins,
  testEndpoints: config.nodeEnv !== "production",
});

const checks = [
  createDatabaseCheck(sql),
  { name: "migrations", check: () => migrationsCurrent(sql) },
  listener,
];
const api = createStaffApi({ auth, sql, checks });

await startService({
  service: "staff-api",
  logger,
  port,
  fetch(request) {
    return api.handle(request);
  },
  checks,
  budget: {
    sql,
    service: "staff-api",
    replicas: parseReplicas(Bun.env.BULLETIN_REPLICAS),
  },
  security: { nodeEnv: config.nodeEnv, connectSrc: [config.authIssuer] },
  async onShutdown() {
    await auth.close();
    await listener.close();
    await sql.close();
  },
}).catch(async (error: unknown) => {
  await auth.close();
  await listener.close();
  await sql.close();
  throw error;
});

logger.info("service listening", { port });
