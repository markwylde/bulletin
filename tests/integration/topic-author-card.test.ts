import { describe, expect, test } from "bun:test";
import { bumpCacheTags, createRenderCache, createTagVersions, memberTag } from "@bulletin/cache";
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
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { isNotModified } from "../../apps/user-app/src/http/cache.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";
import { renderMemberCards } from "../../apps/user-app/src/topics/fragments.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "author_card" }, async (database) => {
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

integrationDescribe("author card fragment", () => {
  test("a post-count change rebuilds the card while the topic page stays cached", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const member = await memberSession(database, "member-1");
      const topicResult = await startTopic(database.sql, {
        actorId: member.memberId,
        forumId: offTopic,
        title: "Card topic",
        bodyMd: "Body.",
      });

      if (!topicResult.ok) {
        throw new Error(`Could not start the topic: ${topicResult.code}`);
      }

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
            ref: `${topicResult.result.topicId}-card-topic`,
            pluginsGeneration: 1,
            colourScheme: "system",
            cache,
            tagVersions: versions,
          });

        const first = await render();
        const warm = await render();

        expect(first.kind).toBe("page");
        expect(warm.kind).toBe("page");
        expect(first.kind === "page" ? first.cache : null).toBe("miss");
        expect(warm.kind === "page" ? warm.cache : null).toBe("hit");
        expect(warm.kind === "page" ? warm.html : "").toContain("data-member-card");
        expect(warm.kind === "page" ? warm.etag : null).toBe(
          first.kind === "page" ? first.etag : null,
        );

        await database.sql`
          UPDATE core.members SET post_count = 987 WHERE id = ${member.memberId}
        `;
        await bumpCacheTags(database.sql, [memberTag(member.memberId)]);
        await versions.refresh();

        const after = await render();
        expect(after.kind).toBe("page");
        // The topic page's own tags did not move, so only the referenced card rebuilt.
        expect(after.kind === "page" ? after.cache : null).toBe("hit");
        expect(after.kind === "page" ? after.html : "").toContain("987 posts");
        expect(after.kind === "page" ? after.etag : null).not.toBe(
          warm.kind === "page" ? warm.etag : null,
        );
        expect(
          isNotModified(
            warm.kind === "page" ? warm.etag : null,
            after.kind === "page" ? after.etag : null,
          ),
        ).toBe(false);
      } finally {
        await versions.close();
      }
    });
  }, 45_000);

  test("the card carries no viewer-specific state", async () => {
    await withSeededDb(async (database) => {
      const member = await memberSession(database, "member-1");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const first = await renderMemberCards(
          database.sql,
          cache,
          [member.memberId],
          "en",
          translate,
        );
        const second = await renderMemberCards(
          database.sql,
          cache,
          [member.memberId],
          "en",
          translate,
        );
        const html = first.get(member.memberId) ?? "";

        expect(html).toBe(second.get(member.memberId) ?? "");
        expect(html).toContain("data-member-card");
        expect(html).not.toContain("data-overlay");
        expect(html).not.toContain("data-unread");
      } finally {
        await versions.close();
      }
    });
  }, 30_000);
});
