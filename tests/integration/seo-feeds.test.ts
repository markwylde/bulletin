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
import { can, GUEST_PRINCIPAL } from "@bulletin/domain/permissions";
import {
  guestCanReadForum,
  loadGuestSeoAccess,
  readForumFeed,
  readGuestFeedForum,
} from "@bulletin/domain/seo";
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

interface ParsedEntry {
  readonly title: string;
  readonly link: string;
  readonly author: string;
  readonly date: string;
  readonly excerpt: string;
}

function field(block: string, pattern: RegExp): string {
  return pattern.exec(block)?.[1] ?? "";
}

function rssItems(xml: string): readonly ParsedEntry[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => {
    const block = match[1] ?? "";

    return {
      title: field(block, /<title>([^<]*)<\/title>/),
      link: field(block, /<link>([^<]*)<\/link>/),
      author: field(block, /<dc:creator>([^<]*)<\/dc:creator>/),
      date: field(block, /<pubDate>([^<]*)<\/pubDate>/),
      excerpt: field(block, /<description>([^<]*)<\/description>/),
    };
  });
}

function atomEntries(xml: string): readonly ParsedEntry[] {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const block = match[1] ?? "";

    return {
      title: field(block, /<title>([^<]*)<\/title>/),
      link: field(block, /<link rel="alternate" href="([^"]*)"\/>/),
      author: field(block, /<author><name>([^<]*)<\/name><\/author>/),
      date: field(block, /<published>([^<]*)<\/published>/),
      excerpt: field(block, /<summary type="text">([^<]*)<\/summary>/),
    };
  });
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

  test("a public forum's feed lists exactly its 20 newest topics with every required field", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const announcements = await forumId(database, "announcements");
      const author = await memberId(database, "member-1");
      const [authorRow] = (await database.sql`
        SELECT display_name FROM core.members WHERE id = ${author}
      `) as Array<{ display_name: string }>;
      const authorName = authorRow?.display_name ?? "";
      const created: Array<{ id: string; title: string; body: string; at: Date }> = [];

      // 25 topics newer than anything seeded, one minute apart, so only the last 20 qualify.
      for (let index = 0; index < 25; index += 1) {
        const at = new Date(Date.UTC(2040, 0, 1, 0, index));
        const title = `Forum feed topic ${String(index).padStart(2, "0")}`;
        const body = `Excerpt for forum feed topic ${index}.`;
        const id = await insertFeedTopic(database, {
          forumId: offTopic,
          authorId: author,
          title,
          bodyText: body,
          lastPostAt: at,
        });

        created.push({ id, title, body, at });
      }

      // Newer still, but in another forum: never part of this forum's feed.
      const elsewhere = await insertFeedTopic(database, {
        forumId: announcements,
        authorId: author,
        title: "Newer topic in another forum",
        bodyText: "Not in the off-topic feed.",
        lastPostAt: new Date("2050-01-01T00:00:00Z"),
      });
      const expected = created.slice(5).reverse();
      const slugs = (await database.sql`
        SELECT id::text AS id, slug FROM core.topics
        WHERE id = ANY(${`{${expected.map((topic) => topic.id).join(",")}}`}::bigint[])
      `) as Array<{ id: string; slug: string }>;
      const slugById = new Map(slugs.map((row) => [row.id, row.slug]));
      const link = (id: string) => `${ORIGIN}/topic/${id}-${slugById.get(id) ?? ""}`;

      const rss = await feedDocumentFor({
        sql: database.sql,
        origin: ORIGIN,
        format: "rss",
        forumRef: `${offTopic}-off-topic`,
      });
      const atom = await feedDocumentFor({
        sql: database.sql,
        origin: ORIGIN,
        format: "atom",
        forumRef: `${offTopic}-off-topic`,
      });

      expect(rss.status).toBe(200);
      expect(atom.status).toBe(200);
      expect(rss.body).not.toContain(`/topic/${elsewhere}-`);
      expect(atom.body).not.toContain(`/topic/${elsewhere}-`);
      expect(rssItems(rss.body)).toEqual(
        expected.map((topic) => ({
          title: topic.title,
          link: link(topic.id),
          author: authorName,
          date: topic.at.toUTCString(),
          excerpt: topic.body,
        })),
      );
      expect(atomEntries(atom.body)).toEqual(
        expected.map((topic) => ({
          title: topic.title,
          link: link(topic.id),
          author: authorName,
          date: topic.at.toISOString(),
          excerpt: topic.body,
        })),
      );
    });
  });

  test("guest readability is decided by can() and denies member-only and password forums", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const staffRoom = await forumId(database, "staff-room");
      const generalDiscussion = await forumId(database, "general-discussion");
      const access = await loadGuestSeoAccess(database.sql);

      // Every forum's verdict matches can() on the Guests snapshot (ADR 0005).
      for (const id of access.tree.ids) {
        const expected =
          access.tree.get(id)?.passwordProtected !== true &&
          (await can(database.sql, GUEST_PRINCIPAL, "read", {
            forumId: id,
            tree: access.tree,
            sessionId: null,
            snapshot: access.snapshot,
          }));

        expect(access.readableForumIds.includes(id)).toBe(expected);
        expect(await guestCanReadForum(database.sql, access, id)).toBe(expected);
      }

      expect(access.readableForumIds).toContain(offTopic);
      expect(access.readableForumIds).not.toContain(staffRoom);
      expect(access.readableForumIds).not.toContain(generalDiscussion);
      expect(await readGuestFeedForum(database.sql, access, staffRoom)).toBeNull();
      expect(await readGuestFeedForum(database.sql, access, "999999")).toBeNull();
      expect(await readGuestFeedForum(database.sql, access, offTopic)).toMatchObject({
        id: offTopic,
        slug: "off-topic",
      });

      // A password forum is never public, even when its masks let guests read it.
      await database.sql`
        UPDATE core.forums SET password_hash = 'not-a-real-hash' WHERE id = ${offTopic}
      `;
      const locked = await loadGuestSeoAccess(database.sql);

      expect(locked.readableForumIds).not.toContain(offTopic);
      expect(await readGuestFeedForum(database.sql, locked, offTopic)).toBeNull();

      const denied = await feedDocumentFor({
        sql: database.sql,
        origin: ORIGIN,
        format: "atom",
        forumRef: `${offTopic}-off-topic`,
      });
      expect(denied.status).toBe(404);

      const board = await feedDocumentFor({ sql: database.sql, origin: ORIGIN, format: "rss" });
      expect(board.tags).not.toContain(`forum:${offTopic}`);
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
