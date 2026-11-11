import { describe, expect, test } from "bun:test";
import { createRenderCache, createTagVersions } from "@bulletin/cache";
import { runBaseSeed } from "@bulletin/db/seed";
import { readBoardSettings } from "@bulletin/domain/board";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { renderTopicRoute } from "../../apps/user-app/src/topics/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "reaction_seed" }, async (database) => {
    await runBaseSeed({ databaseUrl: database.url });
    await run(database);
  });
}

integrationDescribe("reaction and reputation seed", () => {
  test("seeds the reaction set, reactions, summaries and both reputation sources", async () => {
    await withSeededDb(async (database) => {
      const settings = await readBoardSettings(database.sql);
      expect(settings.reactionsAffectReputation).toBe(true);

      const reactions = (await database.sql`
        SELECT key, weight FROM core.reactions ORDER BY position
      `) as Array<{ key: string; weight: number }>;
      expect(reactions.map((reaction) => reaction.key)).toEqual([
        "like",
        "thanks",
        "love",
        "laugh",
        "wow",
        "sad",
        "confused",
        "angry",
      ]);
      expect(reactions.filter((reaction) => reaction.weight > 0).length).toBeGreaterThan(0);
      expect(reactions.filter((reaction) => reaction.weight < 0).length).toBeGreaterThan(0);

      const [seededReactions] = (await database.sql`
        SELECT count(*)::int AS count FROM core.post_reactions
      `) as Array<{ count: number }>;
      expect(seededReactions?.count ?? 0).toBeGreaterThan(100);

      const [mismatched] = (await database.sql`
        SELECT count(*)::int AS count
        FROM core.posts p
        WHERE p.reaction_summary <> COALESCE(
          (
            SELECT jsonb_object_agg(tally.reaction_id::text, tally.total)
            FROM (
              SELECT reaction_id, count(*)::int AS total
              FROM core.post_reactions
              WHERE post_id = p.id
              GROUP BY reaction_id
            ) tally
          ),
          '{}'::jsonb
        )
      `) as Array<{ count: number }>;
      expect(mismatched?.count ?? -1).toBe(0);

      const sources = (await database.sql`
        SELECT source, count(*)::int AS count
        FROM core.reputation_entries
        GROUP BY source
        ORDER BY source
      `) as Array<{ source: string; count: number }>;
      expect(sources.map((row) => row.source)).toEqual(["reaction", "vote"]);
      expect(sources.every((row) => row.count > 0)).toBe(true);

      const [drift] = (await database.sql`
        SELECT count(*)::int AS count
        FROM core.members m
        WHERE m.reputation <> COALESCE(
          (SELECT sum(e.points)::int FROM core.reputation_entries e WHERE e.receiver_id = m.id),
          0
        )
      `) as Array<{ count: number }>;
      expect(drift?.count ?? -1).toBe(0);

      const [positive] = (await database.sql`
        SELECT count(*)::int AS count FROM core.members WHERE reputation > 0
      `) as Array<{ count: number }>;
      expect(positive?.count ?? 0).toBeGreaterThan(0);
    });
  }, 60_000);

  test("the seeded totals render on a topic page after the seed", async () => {
    await withSeededDb(async (database) => {
      const [topic] = (await database.sql`
        SELECT t.id::text AS id, t.slug, m.id::text AS author_id, m.reputation
        FROM core.topics t
        JOIN core.members m ON m.id = t.starter_id
        WHERE t.title = 'Show us your desk setup'
      `) as Array<{ id: string; slug: string; author_id: string; reputation: number }>;

      if (topic === undefined) {
        throw new Error("Missing the seeded reaction topic");
      }

      expect(topic.reputation).toBeGreaterThan(0);

      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const rendered = await renderTopicRoute({
          sql: database.sql,
          locale: "en",
          translate,
          session: null,
          ref: `${topic.id}-${topic.slug}`,
          pluginsGeneration: 1,
          colourScheme: "system",
          cache: createRenderCache({ tags: versions }),
          tagVersions: versions,
        });

        expect(rendered.kind).toBe("page");
        const html = rendered.kind === "page" ? rendered.html : "";
        expect(html).toMatch(
          new RegExp(`data-reputation-count="${topic.author_id}">${topic.reputation}<`),
        );
        expect(html).toContain("data-reaction-bar");
      } finally {
        await versions.close();
      }
    });
  }, 60_000);
});
