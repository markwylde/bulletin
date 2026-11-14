import { createCdnPurger } from "@bulletin/cache";
import {
  createLogger,
  loadConfig,
  loadStorageEnvironment,
  metricsPortFromEnv,
  parseReplicas,
} from "@bulletin/config";
import {
  createDatabaseCheck,
  createListenerCheck,
  createServiceSql,
  startService,
} from "@bulletin/config/server";
import { initTracing, traceJobData } from "@bulletin/config/tracing";
import {
  createEventWorker,
  createPgBossQueue,
  createRelay,
  type EventSubscriber,
  ensurePgBossQueue,
  registerQueueCollector,
} from "@bulletin/db/events";
import { syncFlagDefinitions } from "@bulletin/db/flags";
import {
  createAttachmentJobs,
  createBadgeJobs,
  createBanJobs,
  createContentJobs,
  createConversationJobs,
  createErasureJobs,
  createExportJobs,
  createForumJobs,
  createLeaderboardJobs,
  createMaintenanceJobs,
  createPromotionJobs,
  createReputationJobs,
  createRetentionJobs,
  createSearchJobs,
  createUnfurlJobs,
  createWarningJobs,
  createWebhookEventHandler,
  createWebhookJobs,
  ERASURE_QUEUE,
  EXPORT_QUEUE,
} from "@bulletin/db/jobs";
import { migrationsCurrent, runMigrations } from "@bulletin/db/migrate";
import { runBaseSeed } from "@bulletin/db/seed";
import type { NotificationRecipientFilter } from "@bulletin/domain/notifications";
import { loadVapidConfig } from "@bulletin/domain/push";
import { ignoreRecipientFilter } from "@bulletin/domain/relationships";
import { WEBHOOK_EVENTS } from "@bulletin/domain/webhooks";
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
import { createPluginJobs, type PluginJobQueue as PluginJobsQueue } from "./plugin-jobs.ts";
import { createPluginEventJobs, type PluginJobQueue } from "./plugins.ts";
import { createPushJobs } from "./push.ts";
import { createReputationEventHandler } from "./reputation.ts";

const config = loadConfig();
const logger = createLogger({ service: "workers", level: config.logLevel });
initTracing({ service: "workers" });
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
registerQueueCollector(sql);
const boss = await createPgBossQueue({
  connectionString: Bun.env.PG_BOSS_DATABASE_URL ?? databaseUrl,
  schema: "pgboss",
  max: 10,
});

// The CDN purge endpoint is deployment configuration; without it nothing can be purged and
// the event handler logs the miss instead of retrying forever.
const purgeUrl = Bun.env.BULLETIN_CDN_PURGE_URL;
const purger = purgeUrl === undefined ? undefined : createCdnPurger({ url: purgeUrl });

const pluginEvents = await createPluginEventJobs({
  sql,
  queue: boss.boss as unknown as PluginJobQueue,
  ensureQueue: (name) => ensurePgBossQueue(boss.boss, name),
  hostUrl: Bun.env.PLUGIN_HOST_INTERNAL_URL ?? "http://plugin-host:3004",
  token: Bun.env.PLUGIN_INTERNAL_TOKEN ?? "bulletin-development-only-internal-token",
  logger: logger.child({ component: "plugin-events" }),
});
await pluginEvents.start();

const pluginJobs = await createPluginJobs({
  sql,
  queue: boss.boss as unknown as PluginJobsQueue,
  ensureQueue: (name) => ensurePgBossQueue(boss.boss, name),
  hostUrl: Bun.env.PLUGIN_HOST_INTERNAL_URL ?? "http://plugin-host:3004",
  token: Bun.env.PLUGIN_INTERNAL_TOKEN ?? "bulletin-development-only-internal-token",
  logger: logger.child({ component: "plugin-jobs" }),
});
await pluginJobs.start();

const workerFlags = createWorkerFlags(sql);
const webhookJobs = await createWebhookJobs({
  boss: boss.boss,
  sql,
  logger: logger.child({ component: "webhooks" }),
  isEnabled: (key, memberId) => workerFlags.enabled(key, memberId),
});
const webhookEventHandler = createWebhookEventHandler({
  boss: boss.boss,
  sql,
  logger: logger.child({ component: "webhooks" }),
  isEnabled: (key, memberId) => workerFlags.enabled(key, memberId),
});

// The core subscriber handles cache invalidation; notifications reacts to content and member
// facts. Plugins receive their events through their own queues (ADR 0009, 0011).
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
      "pm.sent",
      "post.approved",
      "report.resolved",
      "report.rejected",
      "warning.issued",
    ],
  },
  {
    name: "badges",
    types: ["post.approved", "post.created", "topic.created", "reaction.added", "reputation.given"],
  },
  { name: "reputation", types: ["reputation.recount.requested"] },
  { name: "webhooks", types: WEBHOOK_EVENTS },
  { name: "plugins", types: "*" },
];
const relay = createRelay({ sql, subscribers, queue: boss.queue });
const enqueueEmail = async (intentId: string): Promise<void> => {
  await boss.boss.send(
    "email",
    { intentId, ...traceJobData() },
    { singletonKey: `email:${intentId}` },
  );
};
const enqueueExport = async (requestId: string): Promise<void> => {
  await boss.boss.send(
    EXPORT_QUEUE,
    { requestId, ...traceJobData() },
    { singletonKey: `export:${requestId}` },
  );
};
const enqueueErasure = async (requestId: string): Promise<void> => {
  await boss.boss.send(
    ERASURE_QUEUE,
    { requestId, ...traceJobData() },
    { singletonKey: `erasure:${requestId}` },
  );
};
const enqueuePush = async (intentId: string): Promise<void> => {
  await boss.boss.send(
    "push",
    { intentId, ...traceJobData() },
    { singletonKey: `push:${intentId}` },
  );
};
const enqueueFanout = async (job: {
  eventId: string;
  afterMemberId: string;
  throughMemberId: string;
}): Promise<void> => {
  await boss.boss.send(
    NOTIFICATION_FANOUT_QUEUE,
    { ...job, ...traceJobData() },
    {
      singletonKey: `fanout:${job.eventId}:${job.throughMemberId}`,
    },
  );
};
const notificationFilters: readonly NotificationRecipientFilter[] = [
  async (context) =>
    !(await workerFlags.enabled("ignore_list", context.recipient.memberId)) ||
    ignoreRecipientFilter(context),
];
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
const pushJobs = await createPushJobs({
  boss: boss.boss,
  sql,
  vapid: loadVapidConfig(Bun.env, config.nodeEnv),
  logger,
  flags: workerFlags,
});
const exportJobs = await createExportJobs({
  boss: boss.boss,
  sql,
  storage,
  pluginHostUrl: Bun.env.PLUGIN_HOST_INTERNAL_URL ?? "http://plugin-host:3004",
  pluginToken: Bun.env.PLUGIN_INTERNAL_TOKEN ?? "bulletin-development-only-internal-token",
  enqueueEmail,
  logger,
});
const erasureJobs = await createErasureJobs({
  boss: boss.boss,
  sql,
  storage,
  pluginHostUrl: Bun.env.PLUGIN_HOST_INTERNAL_URL ?? "http://plugin-host:3004",
  pluginToken: Bun.env.PLUGIN_INTERNAL_TOKEN ?? "bulletin-development-only-internal-token",
  ...(purger === undefined ? {} : { purge: purger }),
  logger,
});
const eventWorker = await createEventWorker({
  boss: boss.boss,
  sql,
  handlers: {
    core: createCoreEventHandler({
      sql,
      ...(purger === undefined ? {} : { purger }),
      enqueueExport,
      enqueueErasure,
      logger,
    }),
    reputation: createReputationEventHandler({ boss: boss.boss, logger }),
    notifications: createNotificationsEventHandler({
      sql,
      logger,
      flags: workerFlags,
      filters: notificationFilters,
      enqueueEmail,
      enqueuePush,
      enqueueFanout,
    }),
    badges: createBadgeEventHandler({ sql, logger }),
    webhooks: webhookEventHandler,
    plugins: (event) => pluginEvents.dispatch(event).then(() => undefined),
  },
  logger,
});
const notificationFanout = await createNotificationsFanoutWorker({
  boss: boss.boss,
  sql,
  logger,
  flags: workerFlags,
  filters: notificationFilters,
  enqueueEmail,
  enqueuePush,
});
const leaderboardJobs = await createLeaderboardJobs({ boss: boss.boss, sql, logger });
const badgeJobs = await createBadgeJobs({ boss: boss.boss, sql, logger });
const banJobs = await createBanJobs({ boss: boss.boss, sql, logger });
const warningJobs = await createWarningJobs({ boss: boss.boss, sql, logger });
const promotionJobs = await createPromotionJobs({ boss: boss.boss, sql, logger });
const reputationJobs = await createReputationJobs({ boss: boss.boss, sql, logger });
const searchJobs = await createSearchJobs({ boss: boss.boss, sql, logger });
const maintenanceJobs = await createMaintenanceJobs({ boss: boss.boss, sql, logger });
const retentionJobs = await createRetentionJobs({ boss: boss.boss, sql, storage, logger });
const forumJobs = await createForumJobs({ boss: boss.boss, sql, logger });
const contentJobs = await createContentJobs({ boss: boss.boss, sql, logger });
const unfurlJobs = await createUnfurlJobs({ boss: boss.boss, sql, logger, storage });
const attachmentJobs = await createAttachmentJobs({
  boss: boss.boss,
  sql,
  storage,
  logger,
});
const conversationJobs = await createConversationJobs({
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
    .then(() => webhookJobs.enqueuePending())
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
  metricsPort: metricsPortFromEnv(),
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
    await pushJobs.stop();
    await exportJobs.stop();
    await erasureJobs.stop();
    await maintenanceJobs.stop();
    await retentionJobs.stop();
    await leaderboardJobs.stop();
    await badgeJobs.stop();
    await forumJobs.stop();
    await contentJobs.stop();
    await unfurlJobs.stop();
    await attachmentJobs.stop();
    await conversationJobs.stop();
    await warningJobs.stop();
    await banJobs.stop();
    await promotionJobs.stop();
    await reputationJobs.stop();
    await searchJobs.stop();
    await eventWorker.stop();
    await webhookJobs.stop();
    await pluginEvents.stop();
    await pluginJobs.stop();
    await boss.stop();
  },
}).catch(async (error: unknown) => {
  clearInterval(relayTimer);
  await listener.close();
  await notificationFanout.stop();
  await digestJobs.stop();
  await emailJobs.stop();
  await pushJobs.stop();
  await exportJobs.stop();
  await erasureJobs.stop();
  await maintenanceJobs.stop();
  await retentionJobs.stop();
  await leaderboardJobs.stop();
  await badgeJobs.stop();
  await forumJobs.stop();
  await contentJobs.stop();
  await unfurlJobs.stop();
  await attachmentJobs.stop();
  await conversationJobs.stop();
  await warningJobs.stop();
  await promotionJobs.stop();
  await reputationJobs.stop();
  await searchJobs.stop();
  await webhookJobs.stop();
  await boss.stop();
  throw error;
});

logger.info("service listening", { port });
