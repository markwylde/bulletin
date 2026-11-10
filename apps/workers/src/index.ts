import { createLogger, loadConfig, parseReplicas } from "@bulletin/config";
import {
  createDatabaseCheck,
  createListenerCheck,
  createServiceSql,
  startService,
} from "@bulletin/config/server";
import {
  createEventWorker,
  createPgBossQueue,
  createRelay,
  type EventSubscriber,
} from "@bulletin/db/events";
import { syncFlagDefinitions } from "@bulletin/db/flags";
import { createPromotionJobs } from "@bulletin/db/jobs";
import { migrationsCurrent, runMigrations } from "@bulletin/db/migrate";
import { runBaseSeed } from "@bulletin/db/seed";
import { CODE_FLAG_DEFINITIONS } from "@bulletin/flags";

const config = loadConfig();
const logger = createLogger({ service: "workers", level: config.logLevel });
const port = config.port;
const databaseUrl = config.databaseUrl;
const migrationUrl = Bun.env.MIGRATION_DATABASE_URL ?? databaseUrl;

await runMigrations({ databaseUrl: migrationUrl });
await runBaseSeed({ databaseUrl: migrationUrl, seed: config.seed, size: config.seedSize });

const sql = createServiceSql("workers", databaseUrl);
await syncFlagDefinitions(sql, CODE_FLAG_DEFINITIONS);
const listener = await createListenerCheck(sql);
const boss = await createPgBossQueue({
  connectionString: Bun.env.PG_BOSS_DATABASE_URL ?? databaseUrl,
  schema: "pgboss",
  max: 10,
});

// Core subscribers are added by later changes. The relay and worker run from day one so the
// outbox never accumulates unpublished events silently.
const subscribers: EventSubscriber[] = [];
const relay = createRelay({ sql, subscribers, queue: boss.queue });
const eventWorker = await createEventWorker({
  boss: boss.boss,
  sql,
  handlers: {},
  logger,
});
const promotionJobs = await createPromotionJobs({ boss: boss.boss, sql, logger });

let relayInFlight: Promise<void> | undefined;
const relayTimer = setInterval(() => {
  if (relayInFlight !== undefined) {
    return;
  }

  relayInFlight = relay
    .runOnce()
    .then(() => undefined)
    .catch((error: unknown) => {
      logger.error("domain-event relay failed", { error });
    })
    .finally(() => {
      relayInFlight = undefined;
    });
}, 1_000);

await startService({
  service: "workers",
  logger,
  port,
  fetch() {
    return Response.json({ service: "workers", status: "ok" });
  },
  checks: [
    createDatabaseCheck(sql),
    { name: "migrations", check: () => migrationsCurrent(sql) },
    listener,
  ],
  budget: {
    sql,
    service: "workers",
    replicas: parseReplicas(Bun.env.BULLETIN_REPLICAS),
  },
  onShutdown: async () => {
    clearInterval(relayTimer);
    await relayInFlight;
    await listener.close();
    await promotionJobs.stop();
    await eventWorker.stop();
    await boss.stop();
  },
}).catch(async (error: unknown) => {
  clearInterval(relayTimer);
  await listener.close();
  await promotionJobs.stop();
  await boss.stop();
  throw error;
});

logger.info("service listening", { port });
