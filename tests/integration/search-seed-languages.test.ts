import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  topicsSeedModule,
} from "@bulletin/db/seed";
import {
  CapabilityView,
  loadForumTree,
  loadPermissionSnapshot,
} from "@bulletin/domain/permissions";
import { searchContent } from "@bulletin/domain/search";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "search_seed_langs" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        topicsSeedModule,
      ]),
      size: "small",
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

async function capabilityFor(database: TestDatabase, member: string): Promise<CapabilityView> {
  const tree = await loadForumTree(database.sql);
  const snapshot = await loadPermissionSnapshot(database.sql, member, { tree, sessionId: null });

  return new CapabilityView({ ...snapshot, view: "search-seed-langs" });
}

integrationDescribe("search seed languages", () => {
  test("seeded topics carry English, Spanish and French configurations", async () => {
    await withSeededDb(async (database) => {
      const rows = (await database.sql`
        SELECT lang::text AS lang, count(*)::int AS count
        FROM core.topics
        GROUP BY lang
      `) as Array<{ lang: string; count: number }>;
      const counts = new Map(rows.map((row) => [row.lang, row.count]));

      expect(counts.get("english") ?? 0).toBeGreaterThan(0);
      expect(counts.get("spanish") ?? 0).toBeGreaterThan(0);
      expect(counts.get("french") ?? 0).toBeGreaterThan(0);

      const posts = (await database.sql`
        SELECT lang::text AS lang, count(*)::int AS count
        FROM core.posts
        GROUP BY lang
      `) as Array<{ lang: string; count: number }>;
      const postCounts = new Map(posts.map((row) => [row.lang, row.count]));
      expect(postCounts.get("spanish") ?? 0).toBeGreaterThan(0);
      expect(postCounts.get("french") ?? 0).toBeGreaterThan(0);
    });
  });

  test("a sample query in each language finds seeded content", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const capability = await capabilityFor(database, member);

      const english = await searchContent(
        database.sql,
        { capability, locale: "en" },
        { query: "favourite", kind: "topics" },
      );
      const spanish = await searchContent(
        database.sql,
        { capability, locale: "es" },
        { query: "semana", kind: "topics" },
      );
      const french = await searchContent(
        database.sql,
        { capability, locale: "fr" },
        { query: "nouvel", kind: "topics" },
      );

      expect(english.items.length).toBeGreaterThan(0);
      expect(spanish.items.length).toBeGreaterThan(0);
      expect(french.items.length).toBeGreaterThan(0);
    });
  });
});
