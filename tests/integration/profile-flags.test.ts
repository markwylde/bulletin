import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import { runBaseSeed } from "@bulletin/db/seed";
import {
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
} from "@bulletin/domain/permissions";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants, type VariantCase } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderHomeRoute } from "../../apps/user-app/src/home/route.ts";
import { renderLeaderboardRoute } from "../../apps/user-app/src/leaderboards/route.ts";
import { renderOnlineRoute } from "../../apps/user-app/src/members/online-route.ts";
import { renderMemberListRoute } from "../../apps/user-app/src/members/route.ts";
import { renderProfileRoute } from "../../apps/user-app/src/profiles/route.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "profile_flags" }, async (database) => {
    await runBaseSeed({ databaseUrl: database.url });
    await run(database);
  });
}

async function setFlags(
  database: TestDatabase,
  keys: readonly string[],
  value: boolean,
): Promise<void> {
  for (const key of keys) {
    await database.sql`
      UPDATE core.feature_flags
      SET default_value = ${value}, rules = '[]'::jsonb
      WHERE key = ${key}
    `;
  }
}

async function memberAndTopic(
  database: TestDatabase,
): Promise<{ readonly memberRef: string; readonly topicRef: string }> {
  const [member] = (await database.sql`
    SELECT id::text AS id, display_name
    FROM core.members
    WHERE display_name = 'Regular Member One'
  `) as Array<{ id: string; display_name: string }>;
  const [topic] = (await database.sql`
    SELECT t.id::text AS id, t.slug
    FROM core.topics t
    JOIN core.posts p ON p.topic_id = t.id
    WHERE p.author_id = (SELECT id FROM core.members WHERE display_name = 'Regular Member One')
    ORDER BY t.id DESC
    LIMIT 1
  `) as Array<{ id: string; slug: string }>;

  if (member === undefined || topic === undefined) {
    throw new Error("The profile flag fixtures are missing");
  }

  return {
    memberRef: `${member.id}-regular-member-one`,
    topicRef: `${topic.id}-${topic.slug}`,
  };
}

integrationDescribe("member-profiles feature flags", () => {
  test("directory, online and leaderboard pages are 404 when their flag is off", async () => {
    await withDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const common = {
          sql: database.sql,
          locale: "en" as const,
          translate,
          session: null,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          cache,
          tagVersions: versions,
        };

        expect(
          (
            await renderMemberListRoute({
              ...common,
              params: new URLSearchParams(),
            })
          ).status,
        ).toBe(200);
        await setFlags(database, ["member_directory"], false);
        expect(
          (
            await renderMemberListRoute({
              ...common,
              params: new URLSearchParams(),
            })
          ).status,
        ).toBe(404);

        await setFlags(database, ["whos_online"], false);
        const onlineOff = await renderOnlineRoute(common);
        expect(onlineOff.status).toBe(404);
        expect(onlineOff.html).toContain("data-theme-error");

        await setFlags(database, ["leaderboards"], false);
        const leaderboardOff = await renderLeaderboardRoute(common);
        expect(leaderboardOff.status).toBe(404);
        expect(leaderboardOff.html).toContain("data-theme-error");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("profile, signatures, cards and the home summary hide their flag-gated surfaces", async () => {
    await withDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const refs = await memberAndTopic(database);
        const common = {
          sql: database.sql,
          locale: "en" as const,
          translate,
          session: null,
          pluginsGeneration: 1,
          colourScheme: "system" as const,
          cache,
          tagVersions: versions,
        };

        const onProfile = await renderProfileRoute({ ...common, ref: refs.memberRef });
        expect(onProfile.kind).toBe("page");
        expect(onProfile.html).toContain("data-profile-fields");
        expect(onProfile.html).toContain("data-profile-badges");
        expect(onProfile.html).toContain("data-profile-friends");

        await setFlags(
          database,
          ["custom_profile_fields", "badges", "friends", "ignore_list", "signatures"],
          false,
        );
        const offProfile = await renderProfileRoute({ ...common, ref: refs.memberRef });
        expect(offProfile.kind).toBe("page");
        expect(offProfile.html).not.toContain("data-profile-fields");
        expect(offProfile.html).not.toContain("data-profile-badges");
        expect(offProfile.html).not.toContain("data-profile-friends");
        expect(offProfile.html).not.toContain("data-friend-request");
        expect(offProfile.html).not.toContain("data-ignore-toggle");

        const topic = await renderTopicRoute({ ...common, ref: refs.topicRef });
        expect(topic.kind).toBe("page");
        expect(topic.html).not.toContain("data-signature");
        expect(topic.html).not.toContain("data-member-badge");

        await setFlags(database, ["whos_online", "leaderboards"], false);
        const home = await renderHomeRoute(common);
        expect(home.html).not.toContain("data-online-summary");
        expect(home.html).not.toContain("data-today-top-poster");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("the profile cache variant changes when a render flag toggles", async () => {
    await withDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const refs = await memberAndTopic(database);
        const render = async (on: boolean) => {
          await setFlags(database, ["custom_profile_fields"], on);
          const result = await renderProfileRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            ref: refs.memberRef,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

          if (result.kind !== "page") {
            throw new Error("Expected the profile page");
          }

          return {
            variant: result.variant ?? "",
            html: result.html,
            ...(result.cache === null ? {} : { cache: result.cache }),
          };
        };
        const cases: readonly VariantCase[] = [
          { name: "fields-on", render: () => render(true) },
          { name: "fields-off", render: () => render(false) },
        ];

        await assertCacheVariants({
          route: "/profile/[ref]",
          cases,
          cache,
          leaks: [
            {
              description: "custom profile field",
              markers: ["The Netherlands"],
              absentFrom: ["fields-off"],
            },
          ],
        });
      } finally {
        await versions.close();
      }
    });
  }, 45_000);
});
