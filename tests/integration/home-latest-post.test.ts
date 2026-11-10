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
  themesSeedModule,
} from "@bulletin/db/seed";
import { startTopic } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { buildBoardIndex } from "../../apps/user-app/src/forums/index.ts";
import type { UserAppSessionContext } from "../../apps/user-app/src/session.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "home_latest" }, async (database) => {
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

function lastPostMember(
  index: Awaited<ReturnType<typeof buildBoardIndex>>,
  forumId: string,
): string | null {
  for (const category of index.viewModel.categories) {
    const forum = category.forums.find((candidate) => candidate.id === forumId);

    if (forum !== undefined) {
      return forum.lastPost?.memberName ?? null;
    }
  }

  const root = index.viewModel.rootForums.find((candidate) => candidate.id === forumId);
  return root?.lastPost?.memberName ?? null;
}

integrationDescribe("latest readable post on the index", () => {
  test("shows the newest visible post instead of a held post the viewer cannot see", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberSession(database, "member-1");
      const heldAuthor = await memberSession(database, "member-2");
      const moderator = await memberSession(database, "super-mod");
      const topic = await startTopic(database.sql, {
        actorId: author.memberId,
        forumId: offTopic,
        title: "Latest post topic",
        bodyMd: "Visible post.",
      });

      if (!topic.ok) {
        throw new Error("Could not create the topic");
      }

      const [held] = (await database.sql`
        INSERT INTO core.posts (
          topic_id, author_id, body_md, body_html, body_text, render_version,
          sanitiser_version, position, visibility, created_at
        )
        VALUES (
          ${topic.result.topicId}, ${heldAuthor.memberId}, 'Held post',
          '<p>Held post</p>', 'Held post', 1, 1, 2, 'unapproved', now() + interval '1 hour'
        )
        RETURNING id::text AS id, created_at
      `) as Array<{ id: string; created_at: Date }>;

      if (held === undefined) {
        throw new Error("Could not insert the held post");
      }

      // Simulate a stale materialised pointer that names the held post.
      await database.sql`
        UPDATE core.forums
        SET last_topic_id = ${topic.result.topicId},
            last_post_id = ${held.id},
            last_post_member_id = ${heldAuthor.memberId},
            last_post_at = ${held.created_at}
        WHERE id = ${offTopic}
      `;

      const guestIndex = await buildBoardIndex({
        sql: database.sql,
        locale: "en",
        translate,
        session: null,
      });
      expect(lastPostMember(guestIndex, offTopic)).toBe(author.displayName);

      const moderatorIndex = await buildBoardIndex({
        sql: database.sql,
        locale: "en",
        translate,
        session: moderator,
      });
      expect(lastPostMember(moderatorIndex, offTopic)).toBe(heldAuthor.displayName);
    });
  }, 30_000);
});
