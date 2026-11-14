import { describe, expect, test } from "bun:test";
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
  topicsSeedModule,
} from "@bulletin/db/seed";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { sitemapIndexDocument, sitemapPageDocument } from "../../apps/user-app/src/seo/sitemaps.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const ORIGIN = "http://board.test:18080";

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "seo_sitemaps" }, async (database) => {
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
        topicsSeedModule,
      ]),
    });
    await run(database);
  });
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

async function memberId(database: TestDatabase, sub: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return row.member_id;
}

async function visibleTopic(
  database: TestDatabase,
  forum: string,
): Promise<{ id: string; title: string }> {
  const [row] = (await database.sql`
    SELECT t.id::text AS id, t.title
    FROM core.topics t
    WHERE t.forum_id = ${forum}
      AND t.visibility = 'visible'
      AND EXISTS (
        SELECT 1 FROM core.posts p WHERE p.topic_id = t.id AND p.visibility = 'visible'
      )
    ORDER BY t.id DESC
    LIMIT 1
  `) as Array<{ id: string; title: string }>;

  if (row === undefined) {
    throw new Error("Seed has no visible topic");
  }

  return row;
}

function locations(xml: string): readonly string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? "");
}

integrationDescribe("sitemaps", () => {
  test("list guest-readable forums and topics only", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const generalDiscussion = await forumId(database, "general-discussion");
      const staffArea = await forumId(database, "staff-area");
      const staffRoom = await forumId(database, "staff-room");
      const moderationNotes = await forumId(database, "moderation-notes");
      const publicTopic = await visibleTopic(database, announcements);
      const staffTopic = await visibleTopic(database, staffRoom);

      const index = await sitemapIndexDocument({ sql: database.sql, origin: ORIGIN });
      expect(index.status).toBe(200);
      expect(index.tags).toContain("perm");
      expect(locations(index.body)).toContain(`${ORIGIN}/sitemap/forums/1.xml`);
      expect(locations(index.body)).toContain(`${ORIGIN}/sitemap/topics/1.xml`);

      const forums = await sitemapPageDocument({
        sql: database.sql,
        origin: ORIGIN,
        kind: "forums",
        page: 1,
      });
      const forumUrls = locations(forums.body);

      expect(forumUrls).toContain(`${ORIGIN}/forum/${announcements}-announcements`);
      expect(forumUrls).not.toContain(`${ORIGIN}/forum/${generalDiscussion}-general-discussion`);
      expect(forumUrls).not.toContain(`${ORIGIN}/forum/${staffArea}-staff-area`);
      expect(forumUrls).not.toContain(`${ORIGIN}/forum/${staffRoom}-staff-room`);
      expect(forumUrls).not.toContain(`${ORIGIN}/forum/${moderationNotes}-moderation-notes`);

      const topics = await sitemapPageDocument({
        sql: database.sql,
        origin: ORIGIN,
        kind: "topics",
        page: 1,
      });

      expect(topics.body).toContain(`/topic/${publicTopic.id}-`);
      expect(topics.body).not.toContain(`/topic/${staffTopic.id}-`);
      expect(topics.body).not.toContain("staff-room");
      expect(topics.tags).toContain(`forum:${announcements}`);
      expect(topics.tags).not.toContain(`forum:${staffRoom}`);
      expect(topics.body).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T/);
    });
  });

  test("exclude members hidden from the member list", async () => {
    await withSeededDb(async (database) => {
      const visible = await memberId(database, "member-1");
      const hidden = await memberId(database, "member-2");

      await database.sql`
        UPDATE core.members SET hide_from_member_list = true WHERE id = ${hidden}
      `;

      const page = await sitemapPageDocument({
        sql: database.sql,
        origin: ORIGIN,
        kind: "members",
        page: 1,
      });
      const urls = locations(page.body);

      expect(urls.some((url) => url.startsWith(`${ORIGIN}/profile/${visible}-`))).toBe(true);
      expect(urls.some((url) => url.startsWith(`${ORIGIN}/profile/${hidden}-`))).toBe(false);
    });
  });

  test("answer 404 outside the advertised page range", async () => {
    await withSeededDb(async (database) => {
      const page = await sitemapPageDocument({
        sql: database.sql,
        origin: ORIGIN,
        kind: "topics",
        page: 99,
      });

      expect(page.status).toBe(404);
      expect(page.tags).toEqual([]);
    });
  });
});
