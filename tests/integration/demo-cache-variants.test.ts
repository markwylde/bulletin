import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { createServerT } from "@bulletin/i18n";
import { assertCacheVariants, type VariantCase } from "@bulletin/test-utils/cache-variants";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { demoContract } from "../../apps/user-app/src/contracts.ts";
import { type DemoRouteInput, renderDemoRoute } from "../../apps/user-app/src/demo/route.ts";
import { loadViewerFlags } from "../../apps/user-app/src/flags.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { loadActiveTheme } from "../../apps/user-app/src/theme/render.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "demo_variants" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
        flagsSeedModule,
        themesSeedModule,
      ]),
    });
    await run(database);
  });
}

async function memberSession(database: TestDatabase, sub: string): Promise<UserAppSessionContext> {
  const [row] = (await database.sql`
    SELECT i.member_id::text AS member_id, m.display_name
    FROM pii.identities i
    JOIN core.members m ON m.id = i.member_id
    WHERE i.sub = ${sub}
  `) as Array<{ member_id: string; display_name: string | null }>;

  if (row === undefined) {
    throw new Error(`No seeded member ${sub}`);
  }

  return {
    memberId: row.member_id,
    sessionId: "0",
    reauthAt: new Date().toISOString(),
    locale: "en",
    displayName: row.display_name,
  };
}

async function unlockedSession(database: TestDatabase, memberId: string): Promise<string> {
  const [session] = (await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (${memberId}, 'user', decode(md5(random()::text), 'hex'), now() + interval '1 day')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (session === undefined) {
    throw new Error("Could not create a session");
  }

  await database.sql`
    INSERT INTO core.session_grants (session_id, kind, resource_id)
    VALUES (${session.id}, 'forum_password', 3)
  `;

  return session.id;
}

async function renderVariant(
  database: TestDatabase,
  cache: ReturnType<typeof createRenderCache>,
  input: {
    readonly session: UserAppSessionContext | null;
    readonly forumId: string;
    readonly pluginsGeneration?: number;
    readonly showDeleted?: boolean;
  },
) {
  const theme = await loadActiveTheme(database.sql);
  const flags = await loadViewerFlags(database.sql, input.session);
  const request: DemoRouteInput = {
    sql: database.sql,
    boardName: "Bulletin",
    locale: "en",
    translate,
    session: input.session,
    forumId: input.forumId,
    showDeleted: input.showDeleted ?? false,
    pluginsGeneration: input.pluginsGeneration ?? 1,
    colourScheme: "system",
    theme,
    flags,
    cache,
  };

  const result = await renderDemoRoute(request);

  return {
    variant: result.variant ?? `status:${result.status}`,
    html: result.html,
    ...(result.cache === null ? {} : { cache: result.cache }),
  };
}

async function forumActions(database: TestDatabase, forumId: string): Promise<number> {
  const [row] = (await database.sql`
    SELECT actions
    FROM core.forum_permissions
    WHERE forum_id = ${forumId}
      AND mask_id = (SELECT id FROM core.masks WHERE key = 'standard')
  `) as Array<{ actions: number }>;

  return row?.actions ?? 0;
}

async function setForumActions(
  database: TestDatabase,
  forumId: string,
  actions: number,
): Promise<void> {
  await database.sql`
    UPDATE core.forum_permissions
    SET actions = ${actions}
    WHERE forum_id = ${forumId}
      AND mask_id = (SELECT id FROM core.masks WHERE key = 'standard')
  `;
}

async function setCompactFlag(database: TestDatabase, value: boolean): Promise<void> {
  await database.sql`
    UPDATE core.feature_flags SET default_value = ${value} WHERE key = 'compactTopicList'
  `;
}

integrationDescribe("demo route cache variants (ADR 0006)", () => {
  test("every variant dimension produces a distinct entry with no leaked content", async () => {
    await withSeededDb(async (database) => {
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const member = await memberSession(database, "member-1");
        const moderator = await memberSession(database, "super-mod");
        const unlockedId = await unlockedSession(database, member.memberId);
        const unlocked = { ...member, sessionId: unlockedId };
        let revokedActions = 0;

        const cases: VariantCase[] = [
          {
            name: "member reads forum 2",
            render: () => renderVariant(database, cache, { session: member, forumId: "2" }),
          },
          {
            name: "permission revoked forum 2",
            setup: async () => {
              revokedActions = await forumActions(database, "2");
              await setForumActions(database, "2", 0);
            },
            teardown: async () => {
              await setForumActions(database, "2", revokedActions);
            },
            render: () => renderVariant(database, cache, { session: member, forumId: "2" }),
          },
          {
            name: "locked forum 3",
            render: () => renderVariant(database, cache, { session: member, forumId: "3" }),
          },
          {
            name: "unlocked forum 3",
            render: () => renderVariant(database, cache, { session: unlocked, forumId: "3" }),
          },
          {
            name: "member forum 5",
            render: () => renderVariant(database, cache, { session: member, forumId: "5" }),
          },
          {
            name: "moderator forum 5",
            render: () => renderVariant(database, cache, { session: moderator, forumId: "5" }),
          },
          {
            name: "moderator forum 5 with deleted",
            render: () =>
              renderVariant(database, cache, {
                session: moderator,
                forumId: "5",
                showDeleted: true,
              }),
          },
          {
            name: "compact flag off forum 5",
            setup: async () => {
              await setCompactFlag(database, false);
            },
            teardown: async () => {
              await setCompactFlag(database, true);
            },
            render: () => renderVariant(database, cache, { session: member, forumId: "5" }),
          },
          {
            name: "plugin generation 2 forum 2",
            setup: async () => {
              await database.sql`
                INSERT INTO core.hook_fragments (generation, name, body)
                VALUES (2, 'demo.after.topics', '<p class="bl-hook" data-demo-hook="2">{% t "demo.hook" %}</p>')
              `;
            },
            teardown: async () => {
              await database.sql`DELETE FROM core.hook_fragments WHERE generation = 2`;
            },
            render: () =>
              renderVariant(database, cache, {
                session: member,
                forumId: "2",
                pluginsGeneration: 2,
              }),
          },
        ];

        const report = await assertCacheVariants({
          route: demoContract.route,
          cases,
          cache,
          leaks: [
            {
              description: "topics never appear in a denied or locked variant",
              markers: ["Demo topic 1"],
              absentFrom: ["permission revoked forum 2", "locked forum 3"],
            },
            {
              description: "moderator tools never appear for members",
              markers: ["data-demo-mod-tools"],
              absentFrom: ["member forum 5", "compact flag off forum 5"],
            },
            {
              description: "deleted content never appears without see_deleted",
              markers: ["data-demo-deleted"],
              absentFrom: ["member forum 5", "compact flag off forum 5", "moderator forum 5"],
            },
            {
              description: "an unlocked forum's content never appears while locked",
              markers: ["data-demo-locked"],
              absentFrom: ["unlocked forum 3"],
            },
            {
              description: "the compact flag value is part of the variant",
              markers: ['data-demo-compact="true"'],
              absentFrom: ["compact flag off forum 5"],
            },
            {
              description: "the installed-plugin hook fragment is its own variant",
              markers: ['data-demo-hook="2"'],
              absentFrom: ["member reads forum 2"],
            },
          ],
        });

        expect(report.variants.size).toBe(cases.length);
        // The revoked case really rendered the error page, and the unlocked one the topics.
        expect(report.variants.get("permission revoked forum 2")).not.toBe(
          report.variants.get("member reads forum 2"),
        );
        expect(report.variants.get("unlocked forum 3")).not.toBe(
          report.variants.get("locked forum 3"),
        );
        expect(report.variants.get("moderator forum 5")).not.toBe(
          report.variants.get("member forum 5"),
        );
        expect(report.variants.get("moderator forum 5 with deleted")).not.toBe(
          report.variants.get("moderator forum 5"),
        );

        // Same permission bits share one entry (ADR 0006 scenario "same bits share"), even
        // for a different member with no session id in the key.
        const memberTwo = await memberSession(database, "member-2");
        const shared = await renderVariant(database, cache, { session: memberTwo, forumId: "2" });
        const original = await renderVariant(database, cache, { session: member, forumId: "2" });

        expect(shared.variant).toBe(report.variants.get("member reads forum 2"));
        expect(shared.cache).toBe("hit");
        expect(shared.html).toBe(original.html);
      } finally {
        await versions.close();
      }
    });
  }, 30_000);
});
