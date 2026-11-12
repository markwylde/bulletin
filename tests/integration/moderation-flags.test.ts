import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import { bumpFlagTag, loadStoredFlags, syncFlagDefinitions } from "@bulletin/db/flags";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import type { SessionRecord } from "@bulletin/domain/auth";
import { startTopic } from "@bulletin/domain/topics";
import { CODE_FLAG_DEFINITIONS, multimodFlag, warningsFlag } from "@bulletin/flags";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import {
  authorizeStaffRoute,
  STAFF_ROUTES,
  type StaffRoute,
} from "../../apps/staff-api/src/api.ts";
import { createUserApiFlags } from "../../apps/user-api/src/flag-guard.ts";
import { buildAccountPage } from "../../apps/user-app/src/account/page.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { accountContract } from "../../apps/user-app/src/contracts.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { renderThemedPage } from "../../apps/user-app/src/theme/render.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";
import {
  renderOwnWarningsRoute,
  renderStaffWarningsRoute,
} from "../../apps/user-app/src/warnings/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "moderation_flags" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function setFlag(database: TestDatabase, key: string, enabled: boolean): Promise<void> {
  await syncFlagDefinitions(database.sql, CODE_FLAG_DEFINITIONS);
  await database.sql`
    UPDATE core.feature_flags
    SET default_value = ${enabled}, updated_at = now()
    WHERE key = ${key}
  `;
  await bumpFlagTag(database.sql);
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

async function memberSession(database: TestDatabase, sub: string): Promise<UserAppSessionContext> {
  const [row] = (await database.sql`
    SELECT i.member_id::text AS member_id, m.display_name
    FROM pii.identities i JOIN core.members m ON m.id = i.member_id
    WHERE i.sub = ${sub}
  `) as Array<{ member_id: string; display_name: string | null }>;

  if (row === undefined) {
    throw new Error(`Missing seeded member ${sub}`);
  }

  return {
    memberId: row.member_id,
    sessionId: "0",
    reauthAt: new Date().toISOString(),
    locale: "en",
    displayName: row.display_name,
  };
}

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

function staffRoute(id: string): StaffRoute {
  const route = STAFF_ROUTES.find((entry) => entry.id === id);

  if (route === undefined) {
    throw new Error(`Missing staff route ${id}`);
  }

  return route;
}

async function callStaffRoute(
  database: TestDatabase,
  id: string,
  actor: string,
): Promise<Response> {
  const route = staffRoute(id);
  const url = new URL(`http://staff.test${route.path}`);

  return authorizeStaffRoute(route, {
    request: new Request(url),
    url,
    session: { memberId: actor, lastAuthAt: new Date() } as SessionRecord,
    sql: database.sql,
    checks: [],
  });
}

integrationDescribe("moderation feature flags", () => {
  test("declares warnings and multimod off in code and on in the seed", async () => {
    expect(CODE_FLAG_DEFINITIONS).toContain(warningsFlag);
    expect(CODE_FLAG_DEFINITIONS).toContain(multimodFlag);
    expect(warningsFlag).toMatchObject({
      key: "warnings",
      defaultValue: false,
      affectsRender: true,
      clientVisible: true,
    });
    expect(multimodFlag).toMatchObject({
      key: "multimod",
      defaultValue: false,
      affectsRender: true,
      clientVisible: true,
    });

    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "moderation_flag_seed" }, async ({ sql }) => {
      await runSeeds({ sql, registry: new SeedRegistry([baseSeedModule, flagsSeedModule]) });
      const stored = await loadStoredFlags(sql);
      expect(stored.find((flag) => flag.key === "warnings")?.defaultValue).toBe(true);
      expect(stored.find((flag) => flag.key === "multimod")?.defaultValue).toBe(true);
    });
  }, 60_000);

  test("the user API answers 404 for every warnings and multimod route when the flags are off", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      await setFlag(database, "warnings", false);
      await setFlag(database, "multimod", false);
      const flags = createUserApiFlags(database.sql);
      const routes = [
        ["warnings", "GET", "/api/me/warnings"],
        ["warnings", "POST", "/api/me/warnings/ack"],
        ["warnings", "GET", "/api/moderation/warnings/reasons"],
        ["warnings", "GET", "/api/moderation/warnings/1"],
        ["warnings", "POST", "/api/moderation/warnings"],
        ["warnings", "POST", "/api/warnings/1/revoke"],
        ["multimod", "POST", "/api/moderation/multimod"],
      ] as const;

      for (const [key, method, path] of routes) {
        let called = false;
        const response = await flags.guard(key, member)(
          new Request(`http://user.test${path}`, { method }),
          () => {
            called = true;
            return new Response("ok");
          },
        );

        expect({ path, status: response.status }).toEqual({ path, status: 404 });
        expect({ path, called }).toEqual({ path, called: false });
      }

      await setFlag(database, "warnings", true);
      await setFlag(database, "multimod", true);
      const enabled = createUserApiFlags(database.sql);
      const warnings = await enabled.guard("warnings", member)(
        new Request("http://user.test/api/me/warnings"),
        () => new Response("ok"),
      );
      const multimod = await enabled.guard("multimod", member)(
        new Request("http://user.test/api/moderation/multimod", { method: "POST" }),
        () => new Response("ok"),
      );
      expect(warnings.status).toBe(200);
      expect(multimod.status).toBe(200);
    });
  }, 60_000);

  test("the staff API answers 404 for warnings and multimod routes when the flags are off", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      await setFlag(database, "warnings", false);
      await setFlag(database, "multimod", false);

      expect((await callStaffRoute(database, "warnings.settings", admin)).status).toBe(404);
      expect((await callStaffRoute(database, "moderation.multimod", admin)).status).toBe(404);

      await setFlag(database, "warnings", true);
      await setFlag(database, "multimod", true);
      expect((await callStaffRoute(database, "warnings.settings", admin)).status).toBe(200);
      expect((await callStaffRoute(database, "moderation.multimod", admin)).status).toBe(200);
    });
  }, 60_000);

  test("the warnings pages and account link are absent while the flag is off", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const moderator = await memberSession(database, "super-mod");
      const input = {
        sql: database.sql,
        locale: "en" as const,
        translate,
        pluginsGeneration: 1,
        colourScheme: "system" as const,
      };
      await setFlag(database, "warnings", false);

      const ownOff = await renderOwnWarningsRoute({ ...input, session: member });
      expect(ownOff.status).toBe(404);
      expect(ownOff.html).toContain("data-theme-error");
      expect(ownOff.html).not.toContain("data-warnings-page");

      const staffOff = await renderStaffWarningsRoute({
        ...input,
        session: moderator,
        memberId: member.memberId,
      });
      expect(staffOff.status).toBe(404);
      expect(staffOff.html).toContain("data-theme-error");
      expect(staffOff.html).not.toContain("data-staff-warnings-page");

      const account = await buildAccountPage({
        sql: database.sql,
        memberId: member.memberId,
        locale: "en",
        translate,
      });

      if (account === null) {
        throw new Error("expected the account page");
      }

      const renderAccount = (warnings: boolean) =>
        renderThemedPage({
          sql: database.sql,
          boardName: "Bulletin",
          viewer: { isMember: true, displayName: member.displayName },
          locale: "en",
          translate,
          template: "account",
          viewModel: {
            ...account.viewModel,
            flags: { ...account.viewModel.flags, warnings },
          },
          breadcrumbs: account.breadcrumbs,
          route: accountContract,
        });

      expect((await renderAccount(false)).html).not.toContain("data-account-warnings");
      expect((await renderAccount(true)).html).toContain("data-account-warnings");

      await setFlag(database, "warnings", true);
      const ownOn = await renderOwnWarningsRoute({ ...input, session: member });
      expect(ownOn.status).toBe(200);
      expect(ownOn.html).toContain("data-warnings-page");

      const staffOn = await renderStaffWarningsRoute({
        ...input,
        session: moderator,
        memberId: member.memberId,
      });
      expect(staffOn.status).toBe(200);
      expect(staffOn.html).toContain("data-staff-warnings-page");

      const forbidden = await renderStaffWarningsRoute({
        ...input,
        session: member,
        memberId: moderator.memberId,
      });
      expect(forbidden.status).toBe(403);
    });
  }, 60_000);

  test("the topic hides warn and multimod controls and changes variant when both flags turn off", async () => {
    await withSeededDb(async (database) => {
      const author = await memberId(database, "member-1");
      const moderator = await memberSession(database, "super-mod");
      const forum = await forumId(database, "off-topic");
      const topic = await startTopic(database.sql, {
        actorId: author,
        forumId: forum,
        title: "Moderation flag topic",
        bodyMd: "Body.",
      });

      if (!topic.ok) {
        throw new Error("Could not create the topic");
      }

      await database.sql`
        INSERT INTO core.multimod_actions (name, forum_ids, steps)
        VALUES ('Flag test action', ARRAY[${forum}::bigint], '[]'::jsonb)
      `;

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = async (ref: string) => {
          const result = await renderTopicRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: moderator,
            ref,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

          if (result.kind !== "page") {
            throw new Error("expected a topic page");
          }

          return {
            variant: result.variant ?? "",
            html: result.html,
            ...(result.cache === null ? {} : { cache: result.cache }),
          };
        };
        const ref = `${topic.result.topicId}-moderation-flag-topic`;

        await assertCacheVariants({
          route: "/_topic",
          cache,
          cases: [
            {
              name: "off",
              setup: async () => {
                await setFlag(database, "warnings", false);
                await setFlag(database, "multimod", false);
              },
              render: () => render(ref),
            },
            {
              name: "on",
              setup: async () => {
                await setFlag(database, "warnings", true);
                await setFlag(database, "multimod", true);
              },
              render: () => render(ref),
            },
          ],
          leaks: [
            {
              markers: ["data-warn-post", "data-topic-multimod-form", "data-topic-multimod-submit"],
              absentFrom: ["off"],
            },
          ],
        });

        await setFlag(database, "warnings", false);
        await setFlag(database, "multimod", false);
        const off = await render(ref);
        expect(off.html).not.toContain("data-warn-post");
        expect(off.html).not.toContain("data-topic-multimod-form");

        await setFlag(database, "warnings", true);
        await setFlag(database, "multimod", true);
        const on = await render(ref);
        expect(on.html).toContain("data-warn-post");
        expect(on.html).toContain("data-topic-multimod-form");
      } finally {
        await versions.close();
      }
    });
  }, 60_000);
});
