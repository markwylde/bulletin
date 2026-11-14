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
  type SeedModule,
  SeedRegistry,
  themesSeedModule,
  topicsSeedModule,
} from "@bulletin/db/seed";
import { CODE_FLAG_DEFINITIONS, pwaFlag, webPushFlag } from "@bulletin/flags";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { createUserApiFlags } from "../../apps/user-api/src/flag-guard.ts";
import { notificationPreferencesResponse } from "../../apps/user-api/src/notifications.ts";
import { buildNotificationPreferencesPage } from "../../apps/user-app/src/account/notification-preferences.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { notificationPreferencesContract } from "../../apps/user-app/src/contracts.ts";
import { loadViewerFlags } from "../../apps/user-app/src/flags.ts";
import { renderHomeRoute } from "../../apps/user-app/src/home/route.ts";
import { pwaFlagRoute } from "../../apps/user-app/src/pwa/guard.ts";
import { renderThemedPage } from "../../apps/user-app/src/theme/render.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withDb(
  prefix: string,
  modules: readonly SeedModule[],
  run: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry(modules),
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

async function setFlag(database: TestDatabase, key: "pwa" | "web_push", enabled: boolean) {
  await database.sql`
    UPDATE core.feature_flags
    SET default_value = ${enabled}, updated_at = now()
    WHERE key = ${key}
  `;
  await bumpFlagTag(database.sql);
}

integrationDescribe("PWA and push feature flags", () => {
  test("default off, seeded on and declared for the cache variant", async () => {
    expect(pwaFlag).toMatchObject({
      key: "pwa",
      defaultValue: false,
      affectsRender: true,
      clientVisible: true,
    });
    expect(webPushFlag).toMatchObject({
      key: "web_push",
      defaultValue: false,
      affectsRender: true,
      clientVisible: true,
    });
    expect(CODE_FLAG_DEFINITIONS).toContain(pwaFlag);
    expect(CODE_FLAG_DEFINITIONS).toContain(webPushFlag);

    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "pwa_flags_seed" }, async ({ sql }) => {
      await runSeeds({
        sql,
        registry: new SeedRegistry([baseSeedModule, flagsSeedModule]),
      });
      const stored = await loadStoredFlags(sql);
      const byKey = new Map(stored.map((flag) => [flag.key, flag]));

      expect(byKey.get("pwa")?.defaultValue).toBe(true);
      expect(byKey.get("web_push")?.defaultValue).toBe(true);
    });
  }, 60_000);

  test("the render cache key changes when either flag toggles", async () => {
    await withDb("pwa_flags_cache", [baseSeedModule, themesSeedModule], async (database) => {
      await syncFlagDefinitions(database.sql, CODE_FLAG_DEFINITIONS);
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const input = {
          sql: database.sql,
          locale: "en" as const,
          translate,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          cache: createRenderCache({ tags: versions }),
          tagVersions: versions,
        };
        const off = await renderHomeRoute(input);
        expect(off.cache).toBe("miss");
        expect(off.html).not.toContain("data-offline-drafts");

        await setFlag(database, "pwa", true);
        await versions.refresh();
        const pwa = await renderHomeRoute(input);

        expect(pwa.cache).toBe("miss");
        expect(pwa.variant).not.toBe(off.variant);
        expect(pwa.html).toContain("data-offline-drafts");

        await setFlag(database, "web_push", true);
        await versions.refresh();
        const push = await renderHomeRoute(input);

        expect(push.cache).toBe("miss");
        expect(push.variant).not.toBe(pwa.variant);
        expect(push.variant).not.toBe(off.variant);
      } finally {
        await versions.close();
      }
    });
  }, 60_000);

  test("the PWA endpoints answer 404 when the flag is off and recover when on", async () => {
    await withDb("pwa_flags_guard", [baseSeedModule], async (database) => {
      await syncFlagDefinitions(database.sql, CODE_FLAG_DEFINITIONS);
      const request = new Request("http://bulletin.localhost/manifest.webmanifest");

      const off = await pwaFlagRoute(database.sql, request, "pwa", () =>
        Response.json({ ok: true }),
      );
      expect(off.status).toBe(404);

      await setFlag(database, "pwa", true);
      const on = await pwaFlagRoute(database.sql, request, "pwa", () =>
        Response.json({ ok: true }),
      );
      expect(on.status).toBe(200);
      expect(await on.json()).toEqual({ ok: true });

      const api = createUserApiFlags(database.sql);
      const pushOff = await api.guard("web_push", null)(
        new Request("http://user.test/api/push/config"),
        () => Response.json({ ok: true }),
      );
      expect(pushOff.status).toBe(404);

      await setFlag(database, "web_push", true);
      const pushOn = await createUserApiFlags(database.sql).guard("web_push", null)(
        new Request("http://user.test/api/push/config"),
        () => Response.json({ ok: true }),
      );
      expect(pushOn.status).toBe(200);
    });
  }, 60_000);

  test("the preferences page hides the push column and section when web_push is off", async () => {
    await withDb(
      "pwa_flags_preferences",
      [
        baseSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        topicsSeedModule,
        themesSeedModule,
      ],
      async (database) => {
        await syncFlagDefinitions(database.sql, CODE_FLAG_DEFINITIONS);
        const member = await memberId(database, "member-1");

        const renderPreferences = async (pushEnabled: boolean): Promise<string> => {
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
            pushEnabled,
          });
          const themed = await renderThemedPage({
            sql: database.sql,
            boardName: "Bulletin",
            locale: "en",
            translate,
            template: "account-notification-preferences",
            viewModel: {
              title: page.title,
              ...page.viewModel,
              flags: { ...flags.values, pwa: true, web_push: pushEnabled },
            },
            breadcrumbs: [],
            route: notificationPreferencesContract,
          });

          return themed.html;
        };

        const off = await renderPreferences(false);
        expect(off).not.toContain("data-push-settings");
        expect(off).not.toContain('data-preference-channel="push"');

        const deniedPreference = await notificationPreferencesResponse(
          database.sql,
          member,
          new Request("http://user.test/api/notifications/preferences", {
            method: "POST",
            body: JSON.stringify({ type: "topic.reply", channel: "push", enabled: true }),
          }),
          { pushEnabled: false },
        );
        expect(deniedPreference.status).toBe(404);

        await setFlag(database, "web_push", true);
        const on = await renderPreferences(true);
        expect(on).toContain("data-push-settings");
        expect(on).toContain('data-preference-channel="push"');

        const allowedPreference = await notificationPreferencesResponse(
          database.sql,
          member,
          new Request("http://user.test/api/notifications/preferences", {
            method: "POST",
            body: JSON.stringify({ type: "topic.reply", channel: "push", enabled: true }),
          }),
          { pushEnabled: true },
        );
        expect(allowedPreference.status).toBe(200);
      },
    );
  }, 60_000);
});
