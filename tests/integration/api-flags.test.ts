import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import { bumpFlagTag } from "@bulletin/db/flags";
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
} from "@bulletin/db/seed";
import { createPersonalApiKey } from "@bulletin/domain/api";
import { CODE_FLAG_DEFINITIONS } from "@bulletin/flags";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authorizeStaffRoute, STAFF_ROUTES } from "../../apps/staff-api/src/api.ts";
import { handleApiRequest } from "../../apps/user-api/src/api/router.ts";
import { API_ROUTES } from "../../apps/user-api/src/api/routes.ts";
import { createUserApiFlags } from "../../apps/user-api/src/flag-guard.ts";
import { renderApiDocsRoute } from "../../apps/user-app/src/api-docs/route.ts";
import { renderApiKeysRoute } from "../../apps/user-app/src/api-keys/route.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { apiDocsContract, apiKeysContract } from "../../apps/user-app/src/contracts.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });
const FEATURE_KEYS = ["public_api", "webhooks"] as const;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "api_flags" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function setFlags(
  database: TestDatabase,
  enabled: boolean,
  keys: readonly string[] = FEATURE_KEYS,
): Promise<void> {
  await database.sql`
    UPDATE core.feature_flags
    SET default_value = ${enabled}, updated_at = now()
    WHERE key = ANY(${`{${keys.join(",")}}`}::text[])
  `;
  await bumpFlagTag(database.sql);
}

async function memberSession(database: TestDatabase, sub: string): Promise<UserAppSessionContext> {
  const [row] = (await database.sql`
    SELECT i.member_id::text AS member_id, m.display_name
    FROM pii.identities i
    JOIN core.members m ON m.id = i.member_id
    WHERE i.sub = ${sub}
  `) as Array<{ member_id: string; display_name: string | null }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return {
    memberId: row.member_id,
    sessionId: "0",
    reauthAt: new Date().toISOString(),
    locale: "en",
    displayName: row.display_name,
  };
}

function adminSession(memberId: string) {
  return {
    id: "1",
    memberId,
    kind: "staff" as const,
    displayName: "Admin",
    createdAt: new Date(),
    lastSeenAt: new Date(),
    reauthAt: new Date(),
    lastAuthAt: new Date(),
    reauthRetryCount: 0,
    revokedAt: null,
    rotatePending: false,
    viaPreviousToken: false,
    previousTokenExpiresAt: null,
  };
}

describe("public API flag declarations", () => {
  test("are off by default and part of the render variant", () => {
    for (const key of FEATURE_KEYS) {
      const definition = CODE_FLAG_DEFINITIONS.find((candidate) => candidate.key === key);
      expect(definition).toMatchObject({
        key,
        defaultValue: false,
        affectsRender: true,
        clientVisible: true,
      });
    }
  });
});

integrationDescribe("public API feature flags", () => {
  test("the seed turns both flags on", async () => {
    await withSeededDb(async (database) => {
      const rows = (await database.sql`
        SELECT key, default_value FROM core.feature_flags
        WHERE key = ANY(${`{${FEATURE_KEYS.join(",")}}`}::text[])
      `) as Array<{ key: string; default_value: boolean }>;

      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.default_value)).toBe(true);
    });
  }, 30_000);

  test("the /api/v1 router and user-api key guard return 404 when closed", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const request = new Request("http://bulletin.localhost/api/v1/openapi.json");

      const off = await handleApiRequest(request, {
        sql: database.sql,
        routes: API_ROUTES,
        pepper: "flag-test-pepper",
        rateLimitSecret: "flag-test-rate",
        isEnabled: async () => false,
      });
      expect(off?.status).toBe(404);

      const on = await handleApiRequest(request, {
        sql: database.sql,
        routes: API_ROUTES,
        pepper: "flag-test-pepper",
        rateLimitSecret: "flag-test-rate",
        isEnabled: async () => true,
      });
      expect(on?.status).toBe(200);

      const flags = createUserApiFlags(database.sql);
      await setFlags(database, false);
      const refused = await flags.guard("public_api", member.memberId)(request, () =>
        Response.json({ ok: true }),
      );
      expect(refused.status).toBe(404);

      await setFlags(database, true);
      const allowed = await flags.guard("public_api", member.memberId)(request, () =>
        Response.json({ ok: true }),
      );
      expect(allowed.status).toBe(200);
    });
  }, 30_000);

  test("the search endpoint answers 404 for guests and keys when the search flag is off", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const created = await createPersonalApiKey(database.sql, {
        memberId: member.memberId,
        label: "Search flag key",
        scopes: ["read:search"],
        pepper: "flag-test-pepper",
      });
      const search = (key?: string) =>
        handleApiRequest(
          new Request("http://bulletin.localhost/api/v1/search?q=welcome", {
            ...(key === undefined ? {} : { headers: { authorization: `Bearer ${key}` } }),
          }),
          {
            sql: database.sql,
            routes: API_ROUTES,
            pepper: "flag-test-pepper",
            rateLimitSecret: "flag-test-rate",
          },
        );

      await setFlags(database, false, ["search"]);
      expect((await search())?.status).toBe(404);
      expect((await search(created.key))?.status).toBe(404);

      await setFlags(database, true, ["search"]);
      expect((await search(created.key))?.status).toBe(200);
      expect((await search())?.status).toBe(200);
    });
  }, 30_000);

  test("the API docs page is absent when off and its cached variant changes when on", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });
      const cache = createRenderCache({ tags: versions });
      const render = () =>
        renderApiDocsRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });

      try {
        await setFlags(database, false);
        const off = await render();
        expect(off.status).toBe(404);
        expect(off.variant).toBe("flag-off");

        await setFlags(database, true);
        const on = await render();
        const hit = await render();

        expect(on.status).toBe(200);
        expect(on.variant).not.toBe(off.variant);
        expect(on.html).toContain('data-name="ApiDocs"');
        expect(on.errors).toEqual([]);
        expect(hit.cache).toBe("hit");
        expect(hit.variant).toBe(on.variant);
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("registers the actual API page renderers with the cache harness", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });
      const docsCache = createRenderCache({ tags: versions });
      const keysCache = createRenderCache({ tags: versions });
      const english = createServerT("en", { shipped: USER_CATALOGS });
      const french = createServerT("fr", { shipped: USER_CATALOGS });
      const renderDocs = (locale: "en" | "fr", translate: typeof english) =>
        renderApiDocsRoute({
          sql: database.sql,
          locale,
          translate,
          session: null,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache: docsCache,
          tagVersions: versions,
        });

      try {
        await setFlags(database, true);
        await assertCacheVariants({
          route: apiDocsContract.route,
          cache: docsCache,
          cases: [
            {
              name: "english docs",
              async render() {
                const result = await renderDocs("en", english);
                return {
                  variant: result.variant,
                  html: result.html,
                  ...(result.cache === null ? {} : { cache: result.cache }),
                };
              },
            },
            {
              name: "french docs",
              async render() {
                const result = await renderDocs("fr", french);
                return {
                  variant: result.variant,
                  html: result.html,
                  ...(result.cache === null ? {} : { cache: result.cache }),
                };
              },
            },
          ],
        });

        const member = await memberSession(database, "member-1");
        const renderKeys = () =>
          renderApiKeysRoute({
            sql: database.sql,
            locale: "en",
            translate: english,
            session: member,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache: keysCache,
            tagVersions: versions,
          });
        const first = await renderKeys();
        const second = await renderKeys();

        expect(first.status).toBe(200);
        expect(first.cache).toBeNull();
        expect(second.cache).toBeNull();
        expect(first.html).toContain("data-account-api-keys");
        expect(keysCache.size).toBe(0);
        expect(apiKeysContract.cdnCacheable).toBe(false);
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("the personal keys page is absent when either gate is off", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });
      const cache = createRenderCache({ tags: versions });
      const render = () =>
        renderApiKeysRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: member,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache,
          tagVersions: versions,
        });

      try {
        await setFlags(database, false);
        expect((await render()).status).toBe(404);

        await setFlags(database, true);
        expect((await render()).status).toBe(200);
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("staff key and webhook screens return 404 when their flags are off", async () => {
    await withSeededDb(async (database) => {
      const [admin] = (await database.sql`
        SELECT member_id::text AS member_id FROM pii.identities WHERE sub = 'admin'
      `) as Array<{ member_id: string }>;

      if (admin === undefined) {
        throw new Error("Missing admin");
      }

      const keyRoute = STAFF_ROUTES.find((route) => route.id === "apiKeys.list");
      const webhookRoute = STAFF_ROUTES.find((route) => route.id === "webhooks.list");

      if (keyRoute === undefined || webhookRoute === undefined) {
        throw new Error("Missing staff routes");
      }

      const context = (path: string) => ({
        request: new Request(`http://staff.bulletin.localhost${path}`),
        url: new URL(`http://staff.bulletin.localhost${path}`),
        session: adminSession(admin.member_id),
        sql: database.sql,
        checks: [],
      });

      await setFlags(database, false);
      expect((await authorizeStaffRoute(keyRoute, context(keyRoute.path))).status).toBe(404);
      expect((await authorizeStaffRoute(webhookRoute, context(webhookRoute.path))).status).toBe(
        404,
      );

      await setFlags(database, true);
      expect((await authorizeStaffRoute(keyRoute, context(keyRoute.path))).status).toBe(200);
      expect((await authorizeStaffRoute(webhookRoute, context(webhookRoute.path))).status).toBe(
        200,
      );
    });
  }, 30_000);
});
