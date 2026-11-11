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
  reactionsSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { startTopic } from "@bulletin/domain/topics";
import { reactionsFlag, reputationFlag } from "@bulletin/flags";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { createUserApiFlags } from "../../apps/user-api/src/flag-guard.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "reactions_flags" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        reactionsSeedModule,
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

async function startedTopic(database: TestDatabase): Promise<{ topicId: string; postId: string }> {
  const author = await memberSession(database, "member-2");
  const [forum] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = 'off-topic'
  `) as Array<{ id: string }>;
  const result = await startTopic(database.sql, {
    actorId: author.memberId,
    forumId: forum?.id ?? "",
    title: "Flagged reactions topic",
    bodyMd: "React and rate.",
  });

  if (!result.ok) {
    throw new Error(`Could not start the topic: ${result.code}`);
  }

  return { topicId: result.result.topicId, postId: result.result.postId };
}

integrationDescribe("reactions and reputation feature flags", () => {
  test("are off by default in code and on in the seed", async () => {
    expect(reactionsFlag.defaultValue).toBe(false);
    expect(reactionsFlag.affectsRender).toBe(true);
    expect(reactionsFlag.clientVisible).toBe(true);
    expect(reputationFlag.defaultValue).toBe(false);
    expect(reputationFlag.affectsRender).toBe(true);
    expect(reputationFlag.clientVisible).toBe(true);

    await withSeededDb(async (database) => {
      const rows = (await database.sql`
        SELECT key, default_value FROM core.feature_flags
        WHERE key IN ('reactions', 'reputation')
        ORDER BY key
      `) as Array<{ key: string; default_value: boolean }>;
      expect(rows).toEqual([
        { key: "reactions", default_value: true },
        { key: "reputation", default_value: true },
      ]);
    });
  }, 30_000);

  test("hides every surface and changes the cache variant when switched off", async () => {
    await withSeededDb(async (database) => {
      const topic = await startedTopic(database);
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = () =>
          renderTopicRoute({
            sql: database.sql,
            locale: "en",
            translate,
            session: null,
            ref: `${topic.topicId}-flagged-reactions-topic`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

        const on = await render();
        const onHtml = on.kind === "page" ? on.html : "";
        expect(onHtml).toContain("data-reaction-bar");
        expect(onHtml).toContain("data-reputation-count");

        await database.sql`
          UPDATE core.feature_flags
          SET default_value = false
          WHERE key IN ('reactions', 'reputation')
        `;
        await bumpFlagTag(database.sql);
        await versions.refresh();

        const off = await render();
        const offHtml = off.kind === "page" ? off.html : "";
        expect(offHtml).not.toContain("data-reaction-bar");
        expect(offHtml).not.toContain("data-post-reactions");
        expect(offHtml).not.toContain("data-reputation-count");
        expect(offHtml).not.toContain("data-reputation-vote");
        expect(off.kind === "page" ? off.variant : "").not.toBe(
          on.kind === "page" ? on.variant : "",
        );
      } finally {
        await versions.close();
      }
    });
  }, 45_000);

  test("the API guards answer 404 and never call the handler when a flag is off", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      await database.sql`
        UPDATE core.feature_flags
        SET default_value = false
        WHERE key IN ('reactions', 'reputation')
      `;
      await bumpFlagTag(database.sql);
      const flags = createUserApiFlags(database.sql);
      let called = false;
      const next = () => {
        called = true;
        return new Response("ok");
      };

      const reactionGet = await flags.guard("reactions", null)(
        new Request("http://bulletin.localhost/api/posts/1/reactions"),
        next,
      );
      expect(reactionGet.status).toBe(404);

      const reactionPost = await flags.guard("reactions", member.memberId)(
        new Request("http://bulletin.localhost/api/posts/1/reactions", { method: "POST" }),
        next,
      );
      expect(reactionPost.status).toBe(404);

      const reputationPost = await flags.guard("reputation", member.memberId)(
        new Request("http://bulletin.localhost/api/posts/1/reputation", { method: "POST" }),
        next,
      );
      expect(reputationPost.status).toBe(404);
      expect(called).toBe(false);
    });
  }, 30_000);
});
