import { describe, expect, test } from "bun:test";
import { readTagVersion } from "@bulletin/cache";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import {
  applyMultimod,
  bulkAction,
  listMultimodActions,
  mergeTopics,
  readTopicList,
  reply,
  saveMultimodAction,
  splitTopic,
  startTopic,
} from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "topic_tools" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
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

function expectOk<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): T {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
}

async function topicBodyOrder(database: TestDatabase, topicId: string): Promise<string[]> {
  const rows = (await database.sql`
    SELECT body_text FROM core.posts WHERE topic_id = ${topicId} ORDER BY position
  `) as Array<{ body_text: string }>;

  return rows.map((row) => row.body_text);
}

async function topicPositions(database: TestDatabase, topicId: string): Promise<number[]> {
  const rows = (await database.sql`
    SELECT position FROM core.posts WHERE topic_id = ${topicId} ORDER BY position
  `) as Array<{ position: number }>;

  return rows.map((row) => row.position);
}

integrationDescribe("topic moderation tools", () => {
  test("merges topics in date order, leaves a stub and invalidates both topics", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const memberA = await memberId(database, "member-1");
      const memberB = await memberId(database, "member-2");
      const destination = expectOk(
        await startTopic(database.sql, {
          actorId: memberA,
          forumId: forum,
          title: "Destination topic",
          bodyMd: "Older opening.",
        }),
      );
      const source = expectOk(
        await startTopic(database.sql, {
          actorId: memberB,
          forumId: forum,
          title: "Source topic",
          bodyMd: "Newer opening.",
        }),
      );
      expectOk(
        await reply(database.sql, {
          actorId: memberA,
          topicId: destination.topicId,
          bodyMd: "Destination reply.",
        }),
      );
      expectOk(
        await reply(database.sql, {
          actorId: memberB,
          topicId: source.topicId,
          bodyMd: "Source reply.",
        }),
      );

      await database.sql`
        UPDATE core.posts SET created_at = '2026-01-01T10:00:00Z'
        WHERE id = ${destination.postId}
      `;
      await database.sql`
        UPDATE core.posts SET created_at = '2026-01-01T11:00:00Z'
        WHERE id = ${source.postId}
      `;
      await database.sql`
        UPDATE core.posts SET created_at = now() WHERE body_text = 'Destination reply.'
      `;
      await database.sql`
        UPDATE core.posts SET created_at = now() + interval '1 minute'
        WHERE body_text = 'Source reply.'
      `;

      const topicTagBefore = await readTagVersion(database.sql, `topic:${destination.topicId}`);
      const sourceTagBefore = await readTagVersion(database.sql, `topic:${source.topicId}`);
      const forumTagBefore = await readTagVersion(database.sql, `forum:${forum}`);
      const [forumBefore] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;

      const merged = expectOk(
        await mergeTopics(database.sql, {
          actorId: admin,
          destinationTopicId: destination.topicId,
          sourceTopicIds: [source.topicId],
          title: "Merged discussion",
          stubDays: 7,
        }),
      );
      expect(merged.topicId).toBe(destination.topicId);
      expect(await topicBodyOrder(database, destination.topicId)).toEqual([
        "Older opening.",
        "Newer opening.",
        "Destination reply.",
        "Source reply.",
      ]);
      expect(await readTagVersion(database.sql, `topic:${destination.topicId}`)).not.toBe(
        topicTagBefore,
      );
      expect(await readTagVersion(database.sql, `topic:${source.topicId}`)).not.toBe(
        sourceTagBefore,
      );
      expect(await readTagVersion(database.sql, `forum:${forum}`)).not.toBe(forumTagBefore);

      const [stub] = (await database.sql`
        SELECT moved_to::text AS moved_to, stub_expires_at
        FROM core.topics WHERE id = ${source.topicId}
      `) as Array<{ moved_to: string | null; stub_expires_at: Date | null }>;
      expect(stub?.moved_to).toBe(destination.topicId);
      expect(stub?.stub_expires_at).toBeInstanceOf(Date);

      const [forumAfter] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      expect(forumAfter?.topic_count).toBe((forumBefore?.topic_count ?? 0) - 1);
      expect(forumAfter?.post_count).toBe(forumBefore?.post_count);

      const [destinationAfter] = (await database.sql`
        SELECT title, reply_count, first_post_id, last_post_id
        FROM core.topics WHERE id = ${destination.topicId}
      `) as Array<{
        title: string;
        reply_count: number;
        first_post_id: string | null;
        last_post_id: string | null;
      }>;
      expect(destinationAfter?.title).toBe("Merged discussion");
      expect(destinationAfter?.reply_count).toBe(3);
      expect(destinationAfter?.first_post_id).not.toBeNull();
      expect(destinationAfter?.last_post_id).not.toBeNull();

      const secondDestination = expectOk(
        await startTopic(database.sql, {
          actorId: memberA,
          forumId: forum,
          title: "No stub destination",
          bodyMd: "Keeping this topic.",
        }),
      );
      const secondSource = expectOk(
        await startTopic(database.sql, {
          actorId: memberB,
          forumId: forum,
          title: "No stub source",
          bodyMd: "Gone after the merge.",
        }),
      );
      expectOk(
        await mergeTopics(database.sql, {
          actorId: admin,
          destinationTopicId: secondDestination.topicId,
          sourceTopicIds: [secondSource.topicId],
        }),
      );
      expect(
        (await database.sql`SELECT 1 FROM core.topics WHERE id = ${secondSource.topicId}`).length,
      ).toBe(0);
    });
  }, 60_000);

  test("splits selected posts into a new topic and an existing topic", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const source = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Split source",
          bodyMd: "Opening.",
        }),
      );
      const replies: string[] = [];

      for (const body of ["First reply.", "Second reply.", "Third reply.", "Fourth reply."]) {
        replies.push(
          expectOk(
            await reply(database.sql, {
              actorId: member,
              topicId: source.topicId,
              bodyMd: body,
            }),
          ).postId,
        );
      }

      const [forumBefore] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;

      expect(
        await splitTopic(database.sql, {
          actorId: member,
          sourceTopicId: source.topicId,
          postIds: [replies[1] ?? ""],
          target: { kind: "new", forumId: forum, title: "Denied split" },
        }),
      ).toEqual({ ok: false, code: "forbidden" });

      const split = expectOk(
        await splitTopic(database.sql, {
          actorId: admin,
          sourceTopicId: source.topicId,
          postIds: [replies[1] ?? "", replies[2] ?? ""],
          target: { kind: "new", forumId: forum, title: "Off-topic split" },
        }),
      );
      expect(split.postIds).toHaveLength(2);
      expect(await topicBodyOrder(database, split.topicId)).toEqual([
        "Second reply.",
        "Third reply.",
      ]);
      expect(await topicBodyOrder(database, source.topicId)).toEqual([
        "Opening.",
        "First reply.",
        "Fourth reply.",
      ]);
      expect(await topicPositions(database, source.topicId)).toEqual([1, 2, 3]);
      expect(await topicPositions(database, split.topicId)).toEqual([1, 2]);

      const [forumAfter] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      expect(forumAfter?.topic_count).toBe((forumBefore?.topic_count ?? 0) + 1);
      expect(forumAfter?.post_count).toBe(forumBefore?.post_count);

      const [sourceCounts] = (await database.sql`
        SELECT reply_count FROM core.topics WHERE id = ${source.topicId}
      `) as Array<{ reply_count: number }>;
      expect(sourceCounts?.reply_count).toBe(2);

      const existing = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Existing split target",
          bodyMd: "Existing opening.",
        }),
      );
      expectOk(
        await splitTopic(database.sql, {
          actorId: admin,
          sourceTopicId: source.topicId,
          postIds: [replies[0] ?? ""],
          target: { kind: "existing", topicId: existing.topicId },
        }),
      );
      expect(await topicBodyOrder(database, existing.topicId)).toEqual([
        "Existing opening.",
        "First reply.",
      ]);
      expect(await topicBodyOrder(database, source.topicId)).toEqual(["Opening.", "Fourth reply."]);
      expect(await topicPositions(database, source.topicId)).toEqual([1, 2]);
      expect(await topicPositions(database, existing.topicId)).toEqual([1, 2]);
    });
  }, 60_000);

  test("bulk locks topics and denies a member without the lock power", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const topics: string[] = [];

      for (let index = 0; index < 5; index += 1) {
        topics.push(
          expectOk(
            await startTopic(database.sql, {
              actorId: member,
              forumId: forum,
              title: `Bulk topic ${index}`,
              bodyMd: `Bulk body ${index}.`,
            }),
          ).topicId,
        );
      }

      const postTopic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Bulk post action topic",
          bodyMd: "Post action opening.",
        }),
      );

      expect(
        await bulkAction(database.sql, {
          actorId: member,
          target: "topics",
          action: "lock",
          ids: topics,
        }),
      ).toEqual({ ok: false, code: "forbidden" });

      const result = expectOk(
        await bulkAction(database.sql, {
          actorId: admin,
          target: "topics",
          action: "lock",
          ids: topics,
        }),
      );
      expect(result.applied).toHaveLength(5);

      const rows = (await database.sql`
        SELECT id::text AS id, locked FROM core.topics
        WHERE id = ANY(${`{${topics.join(",")}}`}::bigint[])
      `) as Array<{ id: string; locked: boolean }>;
      expect(rows).toHaveLength(5);
      expect(rows.every((row) => row.locked)).toBe(true);

      const post = expectOk(
        await reply(database.sql, {
          actorId: member,
          topicId: postTopic.topicId,
          bodyMd: "Bulk post action target.",
        }),
      );
      expectOk(
        await bulkAction(database.sql, {
          actorId: admin,
          target: "posts",
          action: "soft_delete",
          ids: [post.postId],
        }),
      );
      const [deleted] = (await database.sql`
        SELECT visibility FROM core.posts WHERE id = ${post.postId}
      `) as Array<{ visibility: string }>;
      expect(deleted?.visibility).toBe("soft_deleted");

      expectOk(
        await bulkAction(database.sql, {
          actorId: admin,
          target: "posts",
          action: "restore",
          ids: [post.postId],
        }),
      );
      const [restored] = (await database.sql`
        SELECT visibility FROM core.posts WHERE id = ${post.postId}
      `) as Array<{ visibility: string }>;
      expect(restored?.visibility).toBe("visible");
    });
  }, 60_000);

  test("bulk topic deletion hides every reply and restores the complete topic", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Whole topic deletion",
          bodyMd: "Topic opening.",
        }),
      );

      for (const body of ["Reply one.", "Reply two.", "Reply three."]) {
        expectOk(
          await reply(database.sql, {
            actorId: member,
            topicId: topic.topicId,
            bodyMd: body,
          }),
        );
      }

      const [forumBefore] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      const [memberBefore] = (await database.sql`
        SELECT post_count FROM core.members WHERE id = ${member}
      `) as Array<{ post_count: number }>;
      const beforeList = await readTopicList(database.sql, {
        forumId: forum,
        locale: "en",
        sort: "last_post",
        prefixId: null,
        page: 1,
        perPage: 100,
        seeUnapproved: false,
        seeDeleted: false,
      });
      expect(beforeList.rows.map((row) => row.id)).toContain(topic.topicId);

      expectOk(
        await bulkAction(database.sql, {
          actorId: admin,
          target: "topics",
          action: "soft_delete",
          ids: [topic.topicId],
        }),
      );

      const [deleted] = (await database.sql`
        SELECT visibility, reply_count FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ visibility: string; reply_count: number }>;
      expect(deleted).toEqual({ visibility: "soft_deleted", reply_count: 3 });
      const deletedPosts = (await database.sql`
        SELECT visibility FROM core.posts WHERE topic_id = ${topic.topicId}
      `) as Array<{ visibility: string }>;
      expect(deletedPosts).toHaveLength(4);
      expect(deletedPosts.every((post) => post.visibility === "visible")).toBe(true);

      const [forumDuring] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      const [memberDuring] = (await database.sql`
        SELECT post_count FROM core.members WHERE id = ${member}
      `) as Array<{ post_count: number }>;
      expect(forumDuring).toEqual({
        topic_count: (forumBefore?.topic_count ?? 0) - 1,
        post_count: (forumBefore?.post_count ?? 0) - 4,
      });
      expect(memberDuring?.post_count).toBe((memberBefore?.post_count ?? 0) - 4);

      const duringList = await readTopicList(database.sql, {
        forumId: forum,
        locale: "en",
        sort: "last_post",
        prefixId: null,
        page: 1,
        perPage: 100,
        seeUnapproved: false,
        seeDeleted: false,
      });
      expect(duringList.rows.map((row) => row.id)).not.toContain(topic.topicId);

      expectOk(
        await bulkAction(database.sql, {
          actorId: admin,
          target: "topics",
          action: "restore",
          ids: [topic.topicId],
        }),
      );

      const [restored] = (await database.sql`
        SELECT visibility, reply_count FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ visibility: string; reply_count: number }>;
      expect(restored).toEqual({ visibility: "visible", reply_count: 3 });
      expect(await topicBodyOrder(database, topic.topicId)).toEqual([
        "Topic opening.",
        "Reply one.",
        "Reply two.",
        "Reply three.",
      ]);
      expect(await topicPositions(database, topic.topicId)).toEqual([1, 2, 3, 4]);
      const [forumAfter] = (await database.sql`
        SELECT topic_count, post_count FROM core.forums WHERE id = ${forum}
      `) as Array<{ topic_count: number; post_count: number }>;
      const [memberAfter] = (await database.sql`
        SELECT post_count FROM core.members WHERE id = ${member}
      `) as Array<{ post_count: number }>;
      expect(forumAfter).toEqual(forumBefore);
      expect(memberAfter).toEqual(memberBefore);
      const afterList = await readTopicList(database.sql, {
        forumId: forum,
        locale: "en",
        sort: "last_post",
        prefixId: null,
        page: 1,
        perPage: 100,
        seeUnapproved: false,
        seeDeleted: false,
      });
      expect(afterList.rows.map((row) => row.id)).toContain(topic.topicId);

      const logActions = (await database.sql`
        SELECT action FROM core.moderation_log
        WHERE target_type = 'topic' AND target_id = ${topic.topicId}
        ORDER BY id
      `) as Array<{ action: string }>;
      expect(logActions.map((row) => row.action)).toEqual(["topic.delete", "topic.restore"]);
    });
  }, 60_000);

  test("applies mark-solved as one logged multi-moderation action", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Question that gets solved",
          bodyMd: "How do I do this?",
        }),
      );
      const [prefix] = (await database.sql`
        INSERT INTO core.prefixes (key, colour)
        VALUES (${`solved_${Date.now()}`}, '#2f855a')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (prefix === undefined) {
        throw new Error("Could not create the prefix");
      }

      await database.sql`
        INSERT INTO core.forum_prefixes (forum_id, prefix_id)
        VALUES (${forum}, ${prefix.id})
      `;

      const definition = expectOk(
        await saveMultimodAction(database.sql, admin, {
          name: `Mark solved ${Date.now()}`,
          forumIds: [forum],
          steps: [
            { type: "prefix", prefixId: prefix.id },
            { type: "lock", locked: true },
            { type: "reply", bodyMd: "Marked as solved", authorId: null },
          ],
        }),
      );

      const [logBefore] = (await database.sql`
        SELECT count(*)::int AS count FROM core.moderation_log
      `) as Array<{ count: number }>;
      const applied = expectOk(
        await applyMultimod(database.sql, {
          actorId: admin,
          actionId: definition.id,
          topicId: topic.topicId,
        }),
      );
      expect(applied.topicId).toBe(topic.topicId);

      const [row] = (await database.sql`
        SELECT prefix_id::text AS prefix_id, locked, last_post_id::text AS last_post_id
        FROM core.topics WHERE id = ${topic.topicId}
      `) as Array<{ prefix_id: string | null; locked: boolean; last_post_id: string | null }>;
      expect(row?.prefix_id).toBe(prefix.id);
      expect(row?.locked).toBe(true);

      const [lastPost] = (await database.sql`
        SELECT author_id::text AS author_id, body_md
        FROM core.posts WHERE id = ${row?.last_post_id}
      `) as Array<{ author_id: string; body_md: string }>;
      expect(lastPost).toMatchObject({ author_id: admin, body_md: "Marked as solved" });

      const [logAfter] = (await database.sql`
        SELECT count(*)::int AS count FROM core.moderation_log
      `) as Array<{ count: number }>;
      expect(logAfter?.count).toBe((logBefore?.count ?? 0) + 1);
      const logs = (await database.sql`
        SELECT action, target_id::text AS target_id FROM core.moderation_log
        WHERE action = 'multimod.apply'
      `) as Array<{ action: string; target_id: string }>;
      expect(logs).toEqual([{ action: "multimod.apply", target_id: topic.topicId }]);

      expect(
        await applyMultimod(database.sql, {
          actorId: member,
          actionId: definition.id,
          topicId: topic.topicId,
        }),
      ).toEqual({ ok: false, code: "forbidden" });
      expect((await listMultimodActions(database.sql))[0]?.steps).toHaveLength(3);
    });
  }, 60_000);

  test("rejects a reply step author who is not a service member", async () => {
    await withSeededDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");

      expect(
        await saveMultimodAction(database.sql, admin, {
          name: `Bad reply author ${Date.now()}`,
          forumIds: [forum],
          steps: [{ type: "reply", bodyMd: "Should not save", authorId: member }],
        }),
      ).toEqual({ ok: false, code: "invalid_step" });

      const [service] = (await database.sql`
        INSERT INTO core.members (display_name, name_skeleton, is_service)
        VALUES ('Service Bot', 'service-bot', true)
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (service === undefined) {
        throw new Error("Could not create the service member");
      }

      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "Service reply target",
          bodyMd: "Opening.",
        }),
      );
      const definition = expectOk(
        await saveMultimodAction(database.sql, admin, {
          name: `Service reply ${Date.now()}`,
          forumIds: [forum],
          steps: [{ type: "reply", bodyMd: "Service says hello", authorId: service.id }],
        }),
      );
      expectOk(
        await applyMultimod(database.sql, {
          actorId: admin,
          actionId: definition.id,
          topicId: topic.topicId,
        }),
      );
      const [lastPost] = (await database.sql`
        SELECT p.author_id::text AS author_id, p.body_md
        FROM core.topics t JOIN core.posts p ON p.id = t.last_post_id
        WHERE t.id = ${topic.topicId}
      `) as Array<{ author_id: string; body_md: string }>;
      expect(lastPost).toMatchObject({ author_id: service.id, body_md: "Service says hello" });
    });
  }, 60_000);
});
