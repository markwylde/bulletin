import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import { bumpFlagTag } from "@bulletin/db/flags";
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
import { startTopic } from "@bulletin/domain/topics";
import { pollsFlag } from "@bulletin/flags";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { createUserApiFlags } from "../../apps/user-api/src/flag-guard.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderForumRoute } from "../../apps/user-app/src/forums/route.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "polls_flag" }, async (database) => {
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

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

integrationDescribe("polls feature flag", () => {
  test("is off by default in code and on in the seed", async () => {
    expect(pollsFlag.defaultValue).toBe(false);
    expect(pollsFlag.affectsRender).toBe(true);

    await withSeededDb(async (database) => {
      const [row] = (await database.sql`
        SELECT default_value FROM core.feature_flags WHERE key = 'polls'
      `) as Array<{ default_value: boolean }>;
      expect(row?.default_value).toBe(true);
    });
  }, 30_000);

  test("hides every poll surface and invalidates the variant when switched off", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const session = await memberSession(database, "member-1");
      const offTopic = await forumId(database, "off-topic");
      const topic = await startTopic(database.sql, {
        actorId: member,
        forumId: offTopic,
        title: "Poll flag topic",
        bodyMd: "Body.",
        poll: {
          resultsVisibleBeforeVoting: false,
          closesAt: null,
          questions: [
            {
              prompt: "Which?",
              multiple: false,
              choices: [{ label: "One" }, { label: "Two" }],
            },
          ],
        },
      });

      if (!topic.ok) {
        throw new Error("Could not create the poll topic");
      }

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const renderTopic = () =>
          renderTopicRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            ref: `${topic.result.topicId}-poll-flag-topic`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });
        const renderForum = () =>
          renderForumRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session,
            ref: `${offTopic}-off-topic`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

        const onTopic = await renderTopic();
        const onForum = await renderForum();
        expect(onTopic.kind === "page" ? onTopic.html : "").toContain("data-poll-form");
        expect(onForum.kind === "page" ? onForum.html : "").toContain("data-poll-builder");

        await database.sql`
          UPDATE core.feature_flags SET default_value = false WHERE key = 'polls'
        `;
        await bumpFlagTag(database.sql);
        await versions.refresh();

        const offTopicPage = await renderTopic();
        const offForumPage = await renderForum();
        const offTopicHtml = offTopicPage.kind === "page" ? offTopicPage.html : "";
        const offForumHtml = offForumPage.kind === "page" ? offForumPage.html : "";

        expect(offTopicHtml).not.toContain("data-poll-form");
        expect(offTopicHtml).not.toContain("data-poll-id");
        expect(offForumHtml).not.toContain("data-poll-builder");
        expect(offTopicPage.kind === "page" ? offTopicPage.variant : "").not.toBe(
          onTopic.kind === "page" ? onTopic.variant : "",
        );
      } finally {
        await versions.close();
      }
    });
  }, 30_000);

  test("the poll route guard answers 404 when the flag is off", async () => {
    await withSeededDb(async (database) => {
      await database.sql`
        UPDATE core.feature_flags SET default_value = false WHERE key = 'polls'
      `;
      await bumpFlagTag(database.sql);
      const flags = createUserApiFlags(database.sql);
      let called = false;

      const response = await flags.guard("polls", null)(
        new Request("http://bulletin.localhost/api/polls/1/results"),
        () => {
          called = true;
          return new Response("ok");
        },
      );

      expect(response.status).toBe(404);
      expect(called).toBe(false);
    });
  }, 30_000);
});
