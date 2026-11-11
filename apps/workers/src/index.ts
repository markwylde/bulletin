import { createCdnPurger } from "@bulletin/cache";
import { createLogger, loadConfig, loadStorageEnvironment, parseReplicas } from "@bulletin/config";
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
import {
  createAttachmentJobs,
  createContentJobs,
  createForumJobs,
  createMaintenanceJobs,
  createPromotionJobs,
  createUnfurlJobs,
} from "@bulletin/db/jobs";
import { migrationsCurrent, runMigrations } from "@bulletin/db/migrate";
import { runBaseSeed } from "@bulletin/db/seed";
import { CODE_FLAG_DEFINITIONS } from "@bulletin/flags";
import { createStorage } from "@bulletin/storage";
import { createCoreEventHandler } from "./core-events.ts";

const config = loadConfig();
const logger = createLogger({ service: "workers", level: config.logLevel });
const port = config.port;
const databaseUrl = config.databaseUrl;
const migrationUrl = Bun.env.MIGRATION_DATABASE_URL ?? databaseUrl;

const storage = createStorage(loadStorageEnvironment(Bun.env, config.nodeEnv));

await runMigrations({ databaseUrl: migrationUrl });
await runBaseSeed({
  databaseUrl: migrationUrl,
  seed: config.seed,
  size: config.seedSize,
  storage,
});

const sql = createServiceSql("workers", databaseUrl);
await syncFlagDefinitions(sql, CODE_FLAG_DEFINITIONS);
const listener = await createListenerCheck(sql);
const boss = await createPgBossQueue({
  connectionString: Bun.env.PG_BOSS_DATABASE_URL ?? databaseUrl,
  schema: "pgboss",
  max: 10,
});

// The CDN purge endpoint is deployment configuration; without it nothing can be purged and
// the event handler logs the miss instead of retrying forever.
const purgeUrl = Bun.env.BULLETIN_CDN_PURGE_URL;
const purger = purgeUrl === undefined ? undefined : createCdnPurger({ url: purgeUrl });

// The core subscriber handles cache invalidation events; later changes add their own handlers.
const subscribers: EventSubscriber[] = [{ name: "core", types: "*" }];
const relay = createRelay({ sql, subscribers, queue: boss.queue });
const eventWorker = await createEventWorker({
  boss: boss.boss,
  sql,
  handlers: {
    core: createCoreEventHandler({
      sql,
      ...(purger === undefined ? {} : { purger }),
      logger,
    }),
  },
  logger,
});
const promotionJobs = await createPromotionJobs({ boss: boss.boss, sql, logger });
const maintenanceJobs = await createMaintenanceJobs({ boss: boss.boss, sql, logger });
const forumJobs = await createForumJobs({ boss: boss.boss, sql, logger });
const contentJobs = await createContentJobs({ boss: boss.boss, sql, logger });
const unfurlJobs = await createUnfurlJobs({ boss: boss.boss, sql, logger, storage });
const attachmentJobs = await createAttachmentJobs({
  boss: boss.boss,
  sql,
  storage,
  logger,
});

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
    await maintenanceJobs.stop();
    await forumJobs.stop();
    await contentJobs.stop();
    await unfurlJobs.stop();
    await attachmentJobs.stop();
    await promotionJobs.stop();
    await eventWorker.stop();
    await boss.stop();
  },
}).catch(async (error: unknown) => {
  clearInterval(relayTimer);
  await listener.close();
  await maintenanceJobs.stop();
  await forumJobs.stop();
  await contentJobs.stop();
  await unfurlJobs.stop();
  await attachmentJobs.stop();
  await promotionJobs.stop();
  await boss.stop();
  throw error;
});

logger.info("service listening", { port });
