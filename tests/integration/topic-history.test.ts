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
import { loadForumTree } from "@bulletin/domain/permissions";
import { editPost, readPostHistory, readTopic, startTopic } from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "post_history" }, async (database) => {
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

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

integrationDescribe("protected post revisions", () => {
  test("public history hides redacted versions while moderators with view-history see all", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const member = await memberId(database, "member-2");
      const moderator = await memberId(database, "super-mod");
      const topicResult = await startTopic(database.sql, {
        actorId: author,
        forumId: offTopic,
        title: "History topic",
        bodyMd: "First version.",
      });

      if (!topicResult.ok) {
        throw new Error("Could not create the topic");
      }

      const postId = topicResult.result.postId;
      const first = await editPost(database.sql, {
        actorId: author,
        postId,
        bodyMd: "Author version two.",
      });
      expect(first.ok).toBe(true);

      const redacted = await editPost(database.sql, {
        actorId: moderator,
        postId,
        bodyMd: "Moderator redacted version.",
      });
      expect(redacted.ok && redacted.result.redacted).toBe(true);

      const afterRedaction = await editPost(database.sql, {
        actorId: author,
        postId,
        bodyMd: "Author version three.",
      });
      expect(afterRedaction.ok).toBe(true);

      const tree = await loadForumTree(database.sql);
      const topic = await readTopic(database.sql, topicResult.result.topicId);

      if (topic === null) {
        throw new Error("Missing topic");
      }

      const publicHistory = await readPostHistory(database.sql, {
        postId,
        viewerId: member,
        forumId: topic.forumId,
        tree,
        publicHistory: true,
      });
      expect(publicHistory.map((row) => row.bodyMd)).toEqual(["Moderator redacted version."]);
      expect(publicHistory.every((row) => !row.protected)).toBe(true);

      const moderatorHistory = await readPostHistory(database.sql, {
        postId,
        viewerId: moderator,
        forumId: topic.forumId,
        tree,
        publicHistory: true,
      });
      expect(moderatorHistory.map((row) => row.bodyMd)).toEqual([
        "First version.",
        "Author version two.",
        "Moderator redacted version.",
      ]);
      expect(moderatorHistory.filter((row) => row.protected)).toHaveLength(2);

      const denied = await readPostHistory(database.sql, {
        postId,
        viewerId: member,
        forumId: topic.forumId,
        tree,
        publicHistory: false,
      });
      expect(denied).toEqual([]);
    });
  }, 30_000);
});
