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
  createBadgeJobs,
  createContentJobs,
  createForumJobs,
  createLeaderboardJobs,
  createMaintenanceJobs,
  createPromotionJobs,
  createReputationJobs,
  createUnfurlJobs,
} from "@bulletin/db/jobs";
import { migrationsCurrent, runMigrations } from "@bulletin/db/migrate";
import { runBaseSeed } from "@bulletin/db/seed";
import { ignoreRecipientFilter } from "@bulletin/domain/relationships";
import { CODE_FLAG_DEFINITIONS } from "@bulletin/flags";
import { createStorage } from "@bulletin/storage";
import { createBadgeEventHandler } from "./badges.ts";
import { createCoreEventHandler } from "./core-events.ts";
import { createDigestJobs } from "./digest.ts";
import { createEmailJobs } from "./email.ts";
import { createWorkerFlags } from "./flags.ts";
import {
  createNotificationsEventHandler,
  createNotificationsFanoutWorker,
  NOTIFICATION_FANOUT_QUEUE,
} from "./notifications.ts";
import { createReputationEventHandler } from "./reputation.ts";

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

// The core subscriber handles cache invalidation; notifications reacts to content and member
// facts. Later changes add their own handlers (ADR 0011).
const subscribers: EventSubscriber[] = [
  { name: "core", types: "*" },
  {
    name: "notifications",
    types: [
      "topic.created",
      "post.created",
      "member.promoted",
      "reaction.added",
      "reputation.given",
      "friend.accepted",
      "badge.awarded",
    ],
  },
  {
    name: "badges",
    types: ["post.approved", "topic.created", "reaction.added", "reputation.given"],
  },
  { name: "reputation", types: ["reputation.recount.requested"] },
];
const relay = createRelay({ sql, subscribers, queue: boss.queue });
const enqueueEmail = async (intentId: string): Promise<void> => {
  await boss.boss.send("email", { intentId }, { singletonKey: `email:${intentId}` });
};
const enqueueFanout = async (job: {
  eventId: string;
  afterMemberId: string;
  throughMemberId: string;
}): Promise<void> => {
  await boss.boss.send(NOTIFICATION_FANOUT_QUEUE, job, {
    singletonKey: `fanout:${job.eventId}:${job.throughMemberId}`,
  });
};
const workerFlags = createWorkerFlags(sql);
const digestJobs = await createDigestJobs({
  boss: boss.boss,
  sql,
  smtpUrl: config.smtpUrl,
  mailFrom: config.mailFrom,
  userOrigin: config.userOrigin,
  unsubscribeSecret: config.sessionSecret,
  logger,
  flags: workerFlags,
});
const emailJobs = await createEmailJobs({
  boss: boss.boss,
  sql,
  smtpUrl: config.smtpUrl,
  mailFrom: config.mailFrom,
  userOrigin: config.userOrigin,
  unsubscribeSecret: config.sessionSecret,
  logger,
  flags: workerFlags,
});
const eventWorker = await createEventWorker({
  boss: boss.boss,
  sql,
  handlers: {
    core: createCoreEventHandler({
      sql,
      ...(purger === undefined ? {} : { purger }),
      logger,
    }),
    reputation: createReputationEventHandler({ boss: boss.boss, logger }),
    notifications: createNotificationsEventHandler({
      sql,
      logger,
      flags: workerFlags,
      filters: [ignoreRecipientFilter],
      enqueueEmail,
      enqueueFanout,
    }),
    badges: createBadgeEventHandler({ sql, logger }),
  },
  logger,
});
const notificationFanout = await createNotificationsFanoutWorker({
  boss: boss.boss,
  sql,
  logger,
  flags: workerFlags,
  filters: [ignoreRecipientFilter],
  enqueueEmail,
});
const leaderboardJobs = await createLeaderboardJobs({ boss: boss.boss, sql, logger });
const badgeJobs = await createBadgeJobs({ boss: boss.boss, sql, logger });
const promotionJobs = await createPromotionJobs({ boss: boss.boss, sql, logger });
const reputationJobs = await createReputationJobs({ boss: boss.boss, sql, logger });
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
    await notificationFanout.stop();
    await digestJobs.stop();
    await emailJobs.stop();
    await maintenanceJobs.stop();
    await leaderboardJobs.stop();
    await badgeJobs.stop();
    await forumJobs.stop();
    await contentJobs.stop();
    await unfurlJobs.stop();
    await attachmentJobs.stop();
    await promotionJobs.stop();
    await reputationJobs.stop();
    await eventWorker.stop();
    await boss.stop();
  },
}).catch(async (error: unknown) => {
  clearInterval(relayTimer);
  await listener.close();
  await notificationFanout.stop();
  await digestJobs.stop();
  await emailJobs.stop();
  await maintenanceJobs.stop();
  await leaderboardJobs.stop();
  await badgeJobs.stop();
  await forumJobs.stop();
  await contentJobs.stop();
  await unfurlJobs.stop();
  await attachmentJobs.stop();
  await promotionJobs.stop();
  await reputationJobs.stop();
  await boss.stop();
  throw error;
});

logger.info("service listening", { port });
