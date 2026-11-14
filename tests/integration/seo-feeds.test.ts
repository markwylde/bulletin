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
import { loadGuestSeoAccess, readForumFeed } from "@bulletin/domain/seo";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { feedDocumentFor } from "../../apps/user-app/src/seo/feeds.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const ORIGIN = "http://board.test:18080";

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "seo_feeds" }, async (database) => {
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

let sequence = 0;

async function insertFeedTopic(
  database: TestDatabase,
  input: {
    readonly forumId: string;
    readonly authorId: string;
    readonly title: string;
    readonly bodyText: string;
    readonly bodyHtml?: string;
    readonly visibility?: "visible" | "unapproved" | "soft_deleted";
    readonly lastPostAt?: Date;
  },
): Promise<string> {
  sequence += 1;
  const now = input.lastPostAt ?? new Date();
  const [topic] = (await database.sql`
    INSERT INTO core.topics (
      forum_id, title, slug, starter_id, visibility, lang, created_at, updated_at, last_post_at
    )
    VALUES (
      ${input.forumId}, ${input.title}, ${`seo-feed-${sequence}`}, ${input.authorId},
      ${input.visibility ?? "visible"}, 'english'::regconfig, ${now}, ${now}, ${now}
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (topic === undefined) {
    throw new Error("Could not insert the feed topic");
  }

  await database.sql`
    INSERT INTO core.posts (
      topic_id, author_id, body_md, body_html, body_text, render_version,
      sanitiser_version, position, visibility, lang, created_at
    )
    VALUES (
      ${topic.id}, ${input.authorId}, ${input.bodyText},
      ${input.bodyHtml ?? `<p>${input.bodyText}</p>`}, ${input.bodyText}, 1, 1, 1,
      ${input.visibility ?? "visible"}, 'english'::regconfig, ${now}
    )
  `;

  return topic.id;
}

function summaries(xml: string): readonly string[] {
  return [...xml.matchAll(/<summary type="text">([^<]*)<\/summary>/g)].map(
    (match) => match[1] ?? "",
  );
}

integrationDescribe("feeds", () => {
  test("the board feed has 20 recent guest-visible topics and quote-free excerpts", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const staffRoom = await forumId(database, "staff-room");
      const author = await memberId(database, "member-1");
      const staffTopic = await visibleTopic(database, staffRoom);

      const markup = await insertFeedTopic(database, {
        forumId: announcements,
        authorId: author,
        title: "A & B <news>",
        bodyText: "Only the visible passage survives.",
        bodyHtml:
          '<p>Only the visible passage survives.</p><bl-quote data-source="99">quoted secret</bl-quote>',
        lastPostAt: new Date("2030-01-01T00:00:00Z"),
      });
      const deleted = await insertFeedTopic(database, {
        forumId: announcements,
        authorId: author,
        title: "Deleted feed topic",
        bodyText: "This topic is soft deleted.",
        visibility: "soft_deleted",
        lastPostAt: new Date("2030-01-02T00:00:00Z"),
      });
      const unapproved = await insertFeedTopic(database, {
        forumId: announcements,
        authorId: author,
        title: "Unapproved feed topic",
        bodyText: "This topic is awaiting approval.",
        visibility: "unapproved",
        lastPostAt: new Date("2030-01-03T00:00:00Z"),
      });

      const feed = await feedDocumentFor({
        sql: database.sql,
        origin: ORIGIN,
        format: "rss",
      });

      expect(feed.status).toBe(200);
      expect(feed.contentType).toBe("application/rss+xml; charset=utf-8");
      expect(feed.tags).toContain("board");
      expect(feed.tags).toContain(`forum:${announcements}`);
      expect(feed.tags).not.toContain(`forum:${staffRoom}`);

      const items = feed.body.match(/<item>/g) ?? [];
      expect(items).toHaveLength(20);
      expect(feed.body).toContain(`/topic/${markup}-`);
      expect(feed.body).not.toContain(`/topic/${deleted}-`);
      expect(feed.body).not.toContain(`/topic/${unapproved}-`);
      expect(feed.body).not.toContain(staffTopic.title);
      expect(feed.body).toContain("A &amp; B &lt;news&gt;");
      expect(feed.body).toContain("Only the visible passage survives.");
      expect(feed.body).not.toContain("quoted secret");
    });
  });

  test("a forum feed lists that forum only and 404s when guests cannot read it", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const publicTopic = await visibleTopic(database, offTopic);
      const access = await loadGuestSeoAccess(database.sql);
      const feed = await readForumFeed(database.sql, access, offTopic);

      expect(feed.length).toBeGreaterThan(0);
      expect(feed.every((topic) => topic.forumId === offTopic)).toBe(true);
      expect(feed.some((topic) => topic.id === publicTopic.id)).toBe(true);

      const rss = await feedDocumentFor({
        sql: database.sql,
        origin: ORIGIN,
        format: "rss",
        forumRef: `${offTopic}-off-topic`,
      });
      expect(rss.status).toBe(200);
      expect(rss.body).toContain(`/feed/forum/${offTopic}-off-topic.xml`);

      for (const slug of ["staff-room", "general-discussion"]) {
        const denied = await feedDocumentFor({
          sql: database.sql,
          origin: ORIGIN,
          format: "rss",
          forumRef: `${await forumId(database, slug)}-${slug}`,
        });

        expect(denied.status).toBe(404);
        expect(denied.tags).toEqual([]);
      }

      const missing = await feedDocumentFor({
        sql: database.sql,
        origin: ORIGIN,
        format: "rss",
        forumRef: "999999-missing",
      });
      expect(missing.status).toBe(404);
    });
  });

  test("caps excerpts at 300 quote-free characters", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const author = await memberId(database, "member-1");
      const long = `start ${"x".repeat(400)}`;

      await insertFeedTopic(database, {
        forumId: announcements,
        authorId: author,
        title: "Long first post",
        bodyText: long,
        lastPostAt: new Date("2031-01-01T00:00:00Z"),
      });

      const feed = await feedDocumentFor({
        sql: database.sql,
        origin: ORIGIN,
        format: "atom",
      });
      const excerpt = summaries(feed.body)[0] ?? "";

      expect(feed.status).toBe(200);
      expect(feed.contentType).toBe("application/atom+xml; charset=utf-8");
      expect(excerpt).toStartWith("start ");
      expect(excerpt.length).toBeLessThanOrEqual(300);
      expect(feed.body).toContain('<summary type="text">');
    });
  });
});
