import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import { bumpFlagTag, loadStoredFlags, syncFlagDefinitions } from "@bulletin/db/flags";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
  topicsSeedModule,
} from "@bulletin/db/seed";
import {
  createNotification,
  createNotificationEmailIntent,
  listNotifications,
  queueDigests,
  setDigestFrequency,
} from "@bulletin/domain/notifications";
import { reply, startTopic } from "@bulletin/domain/topics";
import { CODE_FLAG_DEFINITIONS } from "@bulletin/flags";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { createUserApiFlags } from "../../apps/user-api/src/flag-guard.ts";
import { buildNotificationPreferencesPage } from "../../apps/user-app/src/account/notification-preferences.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import {
  notificationPreferencesContract,
  topicContract,
} from "../../apps/user-app/src/contracts.ts";
import { loadViewerFlags } from "../../apps/user-app/src/flags.ts";
import { renderThemedPage } from "../../apps/user-app/src/theme/render.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";
import { deliverNotificationEmail } from "../../apps/workers/src/email.ts";
import { createWorkerFlags } from "../../apps/workers/src/flags.ts";
import { createNotificationsEventHandler } from "../../apps/workers/src/notifications.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });
const FEATURE_KEYS = ["notifications", "follows", "digests", "realtime"] as const;

async function withDb(
  prefix: string,
  run: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        topicsSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function memberId(database: TestDatabase, sub: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return row.member_id;
}

function expectOk<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): T {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
}

async function setFeatureFlags(database: TestDatabase, enabled: boolean): Promise<void> {
  await database.sql`
    UPDATE core.feature_flags
    SET default_value = ${enabled}, updated_at = now()
    WHERE key = ANY(${`{${FEATURE_KEYS.join(",")}}`}::text[])
  `;
  await bumpFlagTag(database.sql);
}

integrationDescribe("notification feature flags", () => {
  test("code defaults are off and the seed turns them on", async () => {
    for (const key of FEATURE_KEYS) {
      const definition = CODE_FLAG_DEFINITIONS.find((candidate) => candidate.key === key);
      expect(definition).toMatchObject({
        defaultValue: false,
        affectsRender: true,
        clientVisible: true,
      });
    }

    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "flags_seeded" }, async ({ sql }) => {
      await runSeeds({
        sql,
        registry: new SeedRegistry([baseSeedModule, flagsSeedModule]),
      });

      const seeded = await loadStoredFlags(sql);
      const seededByKey = new Map(seeded.map((flag) => [flag.key, flag]));

      for (const key of FEATURE_KEYS) {
        expect(seededByKey.get(key)?.defaultValue).toBe(true);
      }
    });
  }, 60_000);

  test("each guarded route is absent when its flag is off", async () => {
    await withDb("flags_routes", async (database) => {
      const member = await memberId(database, "member-1");
      await syncFlagDefinitions(database.sql, CODE_FLAG_DEFINITIONS);
      let flags = createUserApiFlags(database.sql);

      for (const key of FEATURE_KEYS) {
        const off = await flags.guard(key, member)(
          new Request("http://user.test/api"),
          () => new Response("ok"),
        );
        expect(off.status).toBe(404);
      }

      await setFeatureFlags(database, true);
      flags = createUserApiFlags(database.sql);

      for (const key of FEATURE_KEYS) {
        const on = await flags.guard(key, member)(
          new Request("http://user.test/api"),
          () => new Response("ok"),
        );
        expect(on.status).toBe(200);
      }
    });
  }, 60_000);

  test("workers respect the notification, follows and digest flags", async () => {
    await withDb("flags_workers", async (database) => {
      await syncFlagDefinitions(database.sql, CODE_FLAG_DEFINITIONS);
      await setFeatureFlags(database, false);
      const starter = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const [forum] = (await database.sql`
        SELECT id::text AS id FROM core.forums WHERE slug = 'off-topic'
      `) as Array<{ id: string }>;
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: starter,
          forumId: forum?.id ?? "0",
          title: "Worker flag topic",
          bodyMd: "Body.",
        }),
      );
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: "A reply.",
        }),
      );
      const [event] = (await database.sql`
        SELECT id FROM core.events WHERE type = 'post.created' ORDER BY id DESC LIMIT 1
      `) as Array<{ id: bigint | string }>;
      const { loadEvent } = await import("@bulletin/domain/events");
      const stored = await loadEvent(database.sql, BigInt(event?.id ?? 0));

      if (stored === null) {
        throw new Error("Missing event");
      }

      await createNotificationsEventHandler({
        sql: database.sql,
        flags: createWorkerFlags(database.sql),
      })(stored);
      expect(await listNotifications(database.sql, starter)).toEqual([]);

      await setFeatureFlags(database, true);
      await createNotificationsEventHandler({
        sql: database.sql,
        flags: createWorkerFlags(database.sql),
      })(stored);
      const notified = await listNotifications(database.sql, starter);
      expect(notified.length).toBeGreaterThan(0);
      const notificationId = notified[0]?.id;

      if (notificationId === undefined) {
        throw new Error("Missing notification");
      }

      const intentId = await createNotificationEmailIntent(
        database.sql,
        starter,
        BigInt(notificationId),
        stored.id,
      );

      if (intentId === null) {
        throw new Error("Missing intent");
      }

      await setFeatureFlags(database, false);
      expect(
        await deliverNotificationEmail(
          database.sql,
          {
            smtpUrl: "smtp://127.0.0.1:1",
            mailFrom: "Bulletin <no-reply@bulletin.test>",
            userOrigin: "http://user.test",
            unsubscribeSecret: "secret",
            flags: createWorkerFlags(database.sql),
          },
          intentId.toString(),
        ),
      ).toBe("skipped");

      await setDigestFrequency(database.sql, starter, "weekly");
      expect(await queueDigests(database.sql, "weekly", { isEnabled: async () => false })).toEqual(
        [],
      );
    });
  }, 60_000);

  test("the topic page cache varies with the follow, notification and realtime flags", async () => {
    await withDb("flags_variants", async (database) => {
      await syncFlagDefinitions(database.sql, CODE_FLAG_DEFINITIONS);
      await setFeatureFlags(database, false);
      const member = await memberId(database, "member-1");
      const [forum] = (await database.sql`
        SELECT id::text AS id FROM core.forums WHERE slug = 'off-topic'
      `) as Array<{ id: string }>;
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum?.id ?? "0",
          title: "Flagged topic",
          bodyMd: "Body.",
        }),
      );
      const [row] = (await database.sql`
        SELECT slug FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ slug: string }>;
      const ref = `${topic.topicId}-${row?.slug ?? "flagged-topic"}`;
      const versions = await createTagVersions({ sql: database.sql, heartbeatMs: 100 });
      const cache = createRenderCache({ tags: versions });

      try {
        await assertCacheVariants({
          route: topicContract.route,
          cache,
          cases: [
            {
              name: "off",
              setup: () => setFeatureFlags(database, false),
              async render() {
                const result = await renderTopicRoute({
                  sql: database.sql,
                  locale: "en",
                  translate,
                  session: null,
                  ref,
                  pluginsGeneration: 1,
                  colourScheme: "system",
                  cache,
                  tagVersions: versions,
                });

                return {
                  variant: result.kind === "page" ? (result.variant ?? "") : "",
                  html: result.kind === "page" ? result.html : "",
                  ...(result.kind === "page" && result.cache !== null
                    ? { cache: result.cache }
                    : {}),
                };
              },
            },
            {
              name: "on",
              setup: () => setFeatureFlags(database, true),
              async render() {
                const result = await renderTopicRoute({
                  sql: database.sql,
                  locale: "en",
                  translate,
                  session: null,
                  ref,
                  pluginsGeneration: 1,
                  colourScheme: "system",
                  cache,
                  tagVersions: versions,
                });

                return {
                  variant: result.kind === "page" ? (result.variant ?? "") : "",
                  html: result.kind === "page" ? result.html : "",
                  ...(result.kind === "page" && result.cache !== null
                    ? { cache: result.cache }
                    : {}),
                };
              },
            },
          ],
          leaks: [
            {
              markers: ["data-follow-context", "data-new-replies", "data-notifications-link"],
              absentFrom: ["off"],
            },
          ],
        });
      } finally {
        await versions.close();
      }
    });
  }, 60_000);

  test("the preferences page hides the digest control when digests is off", async () => {
    await withDb("flags_digest_ui", async (database) => {
      await syncFlagDefinitions(database.sql, CODE_FLAG_DEFINITIONS);
      await setFeatureFlags(database, false);
      const member = await memberId(database, "member-1");

      const renderPreferences = async (): Promise<string> => {
        const flags = await loadViewerFlags(database.sql, {
          memberId: member,
          sessionId: "0",
          reauthAt: new Date().toISOString(),
          locale: "en",
          displayName: "Regular Member One",
        });
        const page = await buildNotificationPreferencesPage({
          sql: database.sql,
          memberId: member,
          translate,
          pushEnabled: true,
        });
        const themed = await renderThemedPage({
          sql: database.sql,
          boardName: "Bulletin",
          locale: "en",
          translate,
          template: "account-notification-preferences",
          viewModel: { title: page.title, ...page.viewModel, flags: flags.values },
          breadcrumbs: [],
          route: notificationPreferencesContract,
        });

        return themed.html;
      };

      expect(await renderPreferences()).not.toContain("data-digest-frequency");

      await setFeatureFlags(database, true);
      expect(await renderPreferences()).toContain("data-digest-frequency");
    });
  }, 60_000);
});
