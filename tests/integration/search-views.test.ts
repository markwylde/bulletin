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
} from "@bulletin/db/seed";
import {
  CapabilityView,
  loadForumTree,
  loadPermissionSnapshot,
  type ViewerPrincipal,
} from "@bulletin/domain/permissions";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import {
  buildMemberContentPage,
  buildNewContentPage,
  buildSearchPage,
} from "../../apps/user-app/src/search/page.ts";
import { renderSearchRoute } from "../../apps/user-app/src/search/route.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "search_views" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
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

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

async function capabilityFor(
  database: TestDatabase,
  principal: ViewerPrincipal,
): Promise<CapabilityView> {
  const tree = await loadForumTree(database.sql);
  const snapshot = await loadPermissionSnapshot(database.sql, principal, { tree, sessionId: null });

  return new CapabilityView({ ...snapshot, view: "search-views" });
}

let sequence = 0;

async function insertContent(
  database: TestDatabase,
  input: {
    readonly forumId: string;
    readonly authorId: string;
    readonly title: string;
    readonly body: string;
    readonly visibility?: "visible" | "unapproved" | "soft_deleted";
    readonly createdAt?: Date;
  },
): Promise<{ readonly topicId: string; readonly postId: string }> {
  sequence += 1;
  const createdAt = input.createdAt ?? new Date();
  const [topic] = (await database.sql`
    INSERT INTO core.topics (forum_id, title, slug, starter_id, created_at, updated_at, last_post_at)
    VALUES (
      ${input.forumId}, ${input.title}, ${`view-test-${sequence}`}, ${input.authorId},
      ${createdAt}, ${createdAt}, ${createdAt}
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (topic === undefined) {
    throw new Error("Could not insert the activity topic");
  }

  const [post] = (await database.sql`
    INSERT INTO core.posts (
      topic_id, author_id, body_md, body_html, body_text, render_version,
      sanitiser_version, position, visibility, created_at
    )
    VALUES (
      ${topic.id}, ${input.authorId}, ${input.body}, ${`<p>${input.body}</p>`}, ${input.body},
      1, 1, 1, ${input.visibility ?? "visible"}, ${createdAt}
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (post === undefined) {
    throw new Error("Could not insert the activity post");
  }

  return { topicId: topic.id, postId: post.id };
}

integrationDescribe("search activity views", () => {
  test("the search page keeps the query and filters in pagination links", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const member = await memberId(database, "member-1");

      for (let index = 0; index < 2; index += 1) {
        await insertContent(database, {
          forumId: announcements,
          authorId: member,
          title: `Paged result ${index + 1}`,
          body: "pagetestword appears here.",
          createdAt: new Date(`2026-01-0${index + 1}T10:00:00.000Z`),
        });
      }

      const capability = await capabilityFor(database, member);
      const view = await buildSearchPage({
        sql: database.sql,
        locale: "en",
        translate,
        principal: member,
        capability,
        params: new URLSearchParams("q=pagetestword&kind=posts&page=1"),
        perPage: 1,
      });

      expect(view.results).toHaveLength(1);
      expect(view.pagination.nextHref).toBe("/search?q=pagetestword&kind=posts&page=2");
    });
  });

  test("content by member only lists readable, current posts and paginates", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const staffRoom = await forumId(database, "staff-room");
      const memberOne = await memberId(database, "member-1");
      const memberTwo = await memberId(database, "member-2");
      const admin = await memberId(database, "admin");
      const first = await insertContent(database, {
        forumId: announcements,
        authorId: memberOne,
        title: "First member post",
        body: "The first visible post.",
        createdAt: new Date("2026-01-01T10:00:00.000Z"),
      });
      const second = await insertContent(database, {
        forumId: announcements,
        authorId: memberOne,
        title: "Second member post",
        body: "The second visible post.",
        createdAt: new Date("2026-01-02T10:00:00.000Z"),
      });
      await insertContent(database, {
        forumId: announcements,
        authorId: memberTwo,
        title: "Someone else's post",
        body: "Not by the member.",
        createdAt: new Date("2026-01-03T10:00:00.000Z"),
      });
      const deleted = await insertContent(database, {
        forumId: announcements,
        authorId: memberOne,
        title: "Deleted post",
        body: "A deleted post.",
        visibility: "soft_deleted",
        createdAt: new Date("2026-01-04T10:00:00.000Z"),
      });
      await insertContent(database, {
        forumId: staffRoom,
        authorId: admin,
        title: "Staff post",
        body: "Staff-only content.",
        createdAt: new Date("2026-01-05T10:00:00.000Z"),
      });

      const capability = await capabilityFor(database, memberOne);
      const view = await buildMemberContentPage({
        sql: database.sql,
        locale: "en",
        translate,
        principal: memberOne,
        capability,
        params: new URLSearchParams(),
        ref: `${memberOne}-regular-member-one`,
        perPage: 1,
      });

      expect(view).not.toBeNull();
      expect(view?.mode).toBe("member");
      expect(view?.results).toHaveLength(1);
      expect(view?.results[0]?.key).toBe(`post:${second.postId}`);
      expect(view?.results[0]?.title).toBe("Second member post");
      expect(view?.pagination.pageCount).toBe(2);
      expect(view?.pagination.nextHref).toBe(
        `/search/member/${memberOne}-regular-member-one?page=2`,
      );

      const pageTwo = await buildMemberContentPage({
        sql: database.sql,
        locale: "en",
        translate,
        principal: memberOne,
        capability,
        params: new URLSearchParams("page=2"),
        ref: `${memberOne}-regular-member-one`,
        perPage: 1,
      });
      expect(pageTwo?.results[0]?.key).toBe(`post:${first.postId}`);
      expect(pageTwo?.results[0]?.title).toBe("First member post");
      expect(pageTwo?.results.map((item) => item.key)).not.toContain(`post:${deleted.postId}`);
      expect(view?.results.map((item) => item.key)).not.toContain(`post:${deleted.postId}`);
    });
  });

  test("new content only lists topics with readable posts after the previous visit", async () => {
    await withSeededDb(async (database) => {
      const announcements = await forumId(database, "announcements");
      const staffRoom = await forumId(database, "staff-room");
      const memberOne = await memberId(database, "member-1");
      const admin = await memberId(database, "admin");
      await database.sql`
        UPDATE core.members
        SET previous_visit_at = '2026-01-10T00:00:00.000Z'
        WHERE id = ${memberOne}
      `;
      const old = await insertContent(database, {
        forumId: announcements,
        authorId: memberOne,
        title: "Before the visit",
        body: "This is older.",
        createdAt: new Date("2026-01-01T10:00:00.000Z"),
      });
      const fresh = await insertContent(database, {
        forumId: announcements,
        authorId: memberOne,
        title: "After the visit",
        body: "This is newer.",
        createdAt: new Date("2026-01-11T10:00:00.000Z"),
      });
      const hidden = await insertContent(database, {
        forumId: staffRoom,
        authorId: admin,
        title: "Staff-only new content",
        body: "A hidden post.",
        createdAt: new Date("2026-01-12T10:00:00.000Z"),
      });

      const capability = await capabilityFor(database, memberOne);
      const view = await buildNewContentPage({
        sql: database.sql,
        locale: "en",
        translate,
        principal: memberOne,
        capability,
        params: new URLSearchParams(),
        memberId: memberOne,
      });

      expect(view).not.toBeNull();
      expect(view?.mode).toBe("new");
      expect(view?.results.map((item) => item.key)).toEqual([`topic:${fresh.topicId}`]);
      expect(view?.results.map((item) => item.key)).not.toContain(`topic:${old.topicId}`);
      expect(view?.results.map((item) => item.key)).not.toContain(`topic:${hidden.topicId}`);
      expect(view?.sinceLabel).toContain("2026");
    });
  });

  test("a guest opening the new-content view is sent to login", async () => {
    await withSeededDb(async (database) => {
      const result = await renderSearchRoute({
        sql: database.sql,
        locale: "en",
        translate,
        session: null,
        params: new URLSearchParams(),
        mode: "new",
      });

      expect(result).toEqual({
        kind: "redirect",
        status: 303,
        location: "/auth/login?return_to=%2Fsearch%2Fnew",
      });
    });
  });

  test("an unknown member ref is a themed not-found", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const capability = await capabilityFor(database, member);
      const view = await buildMemberContentPage({
        sql: database.sql,
        locale: "en",
        translate,
        principal: member,
        capability,
        params: new URLSearchParams(),
        ref: "999999-missing",
      });

      expect(view).toBeNull();
    });
  });
});
