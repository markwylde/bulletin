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
import { insertQuoteSnapshot } from "@bulletin/domain/content";
import { readTopic, readTopicPostPage, reply, startTopic } from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import {
  createTopicResponse,
  editPostResponse,
  postDeleteResponse,
  postHistoryResponse,
  replyResponse,
} from "../../apps/user-api/src/topics.ts";
import {
  completeNewTopic,
  insertPost,
  recordReply,
} from "../../packages/domain/src/topics/repository.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "topic_api" }, async (database) => {
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

function request(method: string, body: unknown): Request {
  return new Request("http://bulletin.localhost/api/posts", {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

function session(memberIdValue: string) {
  return { memberId: memberIdValue, sessionId: "0" };
}

integrationDescribe("topic posting API", () => {
  test("creates a topic and rejects a forum where the member cannot start", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const staff = await forumId(database, "staff-room");
      const member = await memberId(database, "member-1");

      const created = await createTopicResponse(
        database.sql,
        session(member),
        offTopic,
        request("POST", { title: "API topic", bodyMd: "API body." }),
      );
      expect(created.status).toBe(200);
      const body = (await created.json()) as { topicId: string; url: string };
      expect(body.url).toMatch(/^\/topic\/\d+-api-topic$/);

      const topic = await readTopic(database.sql, body.topicId);
      expect(topic?.title).toBe("API topic");

      await database.sql`DELETE FROM core.rate_buckets`;
      const denied = await createTopicResponse(
        database.sql,
        session(member),
        staff,
        request("POST", { title: "No access", bodyMd: "Nope." }),
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ code: "forbidden" });
    });
  }, 30_000);

  test("an older post completing later cannot overwrite the forum's last post", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const member = await memberId(database, "member-1");
      const first = await startTopic(database.sql, {
        actorId: member,
        forumId: offTopic,
        title: "Older completion",
        bodyMd: "First body.",
      });
      const second = await startTopic(database.sql, {
        actorId: member,
        forumId: offTopic,
        title: "Newer completion",
        bodyMd: "Second body.",
      });

      if (!first.ok || !second.ok) {
        throw new Error("Could not create the topics");
      }

      const firstReply = await insertPost(database.sql, {
        topicId: first.result.topicId,
        authorId: member,
        bodyMd: "First reply.",
        bodyHtml: "<p>First reply.</p>",
        bodyText: "First reply.",
        renderVersion: 1,
        sanitiserVersion: 1,
        quotedForumIds: [],
        mentionedMemberIds: [],
        quotedPostIds: [],
      });
      const secondReply = await insertPost(database.sql, {
        topicId: second.result.topicId,
        authorId: member,
        bodyMd: "Second reply.",
        bodyHtml: "<p>Second reply.</p>",
        bodyText: "Second reply.",
        renderVersion: 1,
        sanitiserVersion: 1,
        quotedForumIds: [],
        mentionedMemberIds: [],
        quotedPostIds: [],
      });
      const newer = new Date(Date.now() + 1_000);
      const older = new Date(Date.now() + 500);

      await recordReply(database.sql, {
        topicId: first.result.topicId,
        forumId: offTopic,
        postId: firstReply.id,
        authorId: member,
        createdAt: newer,
      });
      await recordReply(database.sql, {
        topicId: second.result.topicId,
        forumId: offTopic,
        postId: secondReply.id,
        authorId: member,
        createdAt: older,
      });

      const [forum] = (await database.sql`
        SELECT last_post_id::text AS last_post_id, last_post_at
        FROM core.forums WHERE id = ${offTopic}
      `) as Array<{ last_post_id: string; last_post_at: Date }>;
      expect(forum).toMatchObject({ last_post_id: firstReply.id, last_post_at: newer });

      const newestCreation = new Date(Date.now() + 3_000);
      const olderCreation = new Date(Date.now() + 2_000);
      await completeNewTopic(database.sql, {
        topicId: second.result.topicId,
        forumId: offTopic,
        postId: second.result.postId,
        authorId: member,
        createdAt: newestCreation,
      });
      await completeNewTopic(database.sql, {
        topicId: first.result.topicId,
        forumId: offTopic,
        postId: first.result.postId,
        authorId: member,
        createdAt: olderCreation,
      });

      const [afterCreation] = (await database.sql`
        SELECT last_post_id::text AS last_post_id, last_post_at
        FROM core.forums WHERE id = ${offTopic}
      `) as Array<{ last_post_id: string; last_post_at: Date }>;
      expect(afterCreation).toMatchObject({
        last_post_id: second.result.postId,
        last_post_at: newestCreation,
      });
    });
  }, 30_000);

  test("requires a password-forum unlock to start and reply", async () => {
    await withSeededDb(async (database) => {
      const general = await forumId(database, "general-discussion");
      const member = await memberId(database, "member-1");
      const [sessionRow] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (${member}, 'user', decode(md5(random()::text), 'hex'), now() + interval '1 day')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (sessionRow === undefined) {
        throw new Error("Could not create the session");
      }

      await database.sql`
        INSERT INTO core.session_grants (session_id, kind, resource_id)
        VALUES (${sessionRow.id}, 'forum_password', ${general})
      `;

      const locked = await createTopicResponse(
        database.sql,
        session(member),
        general,
        request("POST", { title: "Locked start", bodyMd: "Locked." }),
      );
      expect(locked.status).toBe(403);

      const unlocked = await createTopicResponse(
        database.sql,
        { memberId: member, sessionId: sessionRow.id },
        general,
        request("POST", { title: "Unlocked start", bodyMd: "Unlocked." }),
      );
      expect(unlocked.status).toBe(200);
      const topic = (await unlocked.json()) as { topicId: string };

      await database.sql`DELETE FROM core.rate_buckets`;
      const lockedReply = await replyResponse(
        database.sql,
        session(member),
        topic.topicId,
        request("POST", { bodyMd: "Locked reply." }),
      );
      expect(lockedReply.status).toBe(403);

      const unlockedReply = await replyResponse(
        database.sql,
        { memberId: member, sessionId: sessionRow.id },
        topic.topicId,
        request("POST", { bodyMd: "Unlocked reply." }),
      );
      expect(unlockedReply.status).toBe(200);
    });
  }, 30_000);

  test("enforces flood control and returns the seconds to wait", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const member = await memberId(database, "member-1");

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT id, 'posting.flood_control_seconds', to_jsonb(30)
        FROM core.groups WHERE key = 'members'
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;

      const created = await createTopicResponse(
        database.sql,
        session(member),
        offTopic,
        request("POST", { title: "Flood topic", bodyMd: "First." }),
      );
      expect(created.status).toBe(200);
      const topic = (await created.json()) as { topicId: string };

      const tooFast = await replyResponse(
        database.sql,
        session(member),
        topic.topicId,
        request("POST", { bodyMd: "Too fast." }),
      );
      expect(tooFast.status).toBe(429);
      const retry = (await tooFast.json()) as { code: string; retryAfterSeconds: number };
      expect(retry.code).toBe("flood_control");
      expect(retry.retryAfterSeconds).toBeGreaterThan(0);
      expect(retry.retryAfterSeconds).toBeLessThanOrEqual(30);

      await database.sql`DELETE FROM core.rate_buckets`;
      const accepted = await replyResponse(
        database.sql,
        session(member),
        topic.topicId,
        request("POST", { bodyMd: "After the window." }),
      );
      expect(accepted.status).toBe(200);
    });
  }, 30_000);

  test("rejects an edit outside the window and returns 403 for unavailable history", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const member = await memberId(database, "member-1");
      const created = await startTopic(database.sql, {
        actorId: member,
        forumId: offTopic,
        title: "Window topic",
        bodyMd: "Body.",
      });

      if (!created.ok) {
        throw new Error("Could not create the topic");
      }

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT id, 'posting.edit_window_minutes', to_jsonb(60)
        FROM core.groups WHERE key = 'members'
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;
      await database.sql`
        UPDATE core.posts SET created_at = now() - interval '2 hours'
        WHERE id = ${created.result.postId}
      `;

      const expired = await editPostResponse(
        database.sql,
        session(member),
        created.result.postId,
        request("POST", { bodyMd: "Too late." }),
      );
      expect(expired.status).toBe(403);
      expect(await expired.json()).toEqual({ code: "edit_window_expired" });

      const history = await postHistoryResponse(
        database.sql,
        session(await memberId(database, "member-2")),
        created.result.postId,
      );
      expect(history.status).toBe(403);
      expect(await history.json()).toEqual({ code: "forbidden" });
    });
  }, 30_000);

  test("an author edit under mandatory moderation stays hidden until approved", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const other = await memberId(database, "member-2");
      const topic = await startTopic(database.sql, {
        actorId: other,
        forumId: offTopic,
        title: "Edit moderation topic",
        bodyMd: "Opening body.",
      });

      if (!topic.ok) {
        throw new Error("Could not create the topic");
      }

      const written = await reply(database.sql, {
        actorId: author,
        topicId: topic.result.topicId,
        bodyMd: "Visible before moderation.",
      });

      if (!written.ok) {
        throw new Error("Could not write the reply");
      }

      const [beforeEdit] = (await database.sql`
        SELECT post_count FROM core.members WHERE id = ${author}
      `) as Array<{ post_count: number }>;

      await database.sql`
        INSERT INTO core.member_restrictions (member_id, kind, until)
        VALUES (${author}, 'posts_require_approval', now() + interval '1 day')
      `;

      const edited = await editPostResponse(
        database.sql,
        session(author),
        written.result.postId,
        request("POST", { bodyMd: "Edited while on mandatory moderation." }),
      );
      expect(edited.status).toBe(200);

      const [row] = (await database.sql`
        SELECT visibility FROM core.posts WHERE id = ${written.result.postId}
      `) as Array<{ visibility: string }>;
      expect(row?.visibility).toBe("unapproved");

      const publicPage = await readTopicPostPage(database.sql, {
        topicId: topic.result.topicId,
        limit: 20,
        offset: 0,
        seeUnapproved: false,
        seeDeleted: false,
      });
      expect(publicPage.rows.map((post) => post.id)).not.toContain(written.result.postId);
      expect(publicPage.rows.map((post) => post.bodyMd)).not.toContain(
        "Edited while on mandatory moderation.",
      );

      const [memberCount] = (await database.sql`
        SELECT post_count FROM core.members WHERE id = ${author}
      `) as Array<{ post_count: number }>;
      expect(memberCount?.post_count).toBe((beforeEdit?.post_count ?? 0) - 1);
    });
  }, 30_000);

  test("moderator edit redacts quotes by default through the API", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const moderator = await memberId(database, "super-mod");
      const created = await startTopic(database.sql, {
        actorId: author,
        forumId: offTopic,
        title: "Redact API topic",
        bodyMd: "Original body.",
      });

      if (!created.ok) {
        throw new Error("Could not create the topic");
      }

      const snapshot = await insertQuoteSnapshot(database.sql, {
        sourceKind: "post",
        sourceId: created.result.postId,
        sourceAuthorId: author,
        bodyMd: "Original body.",
        bodyHtml: "<p>Original body.</p>",
        renderVersion: 1,
        sanitiserVersion: 1,
      });
      const edited = await editPostResponse(
        database.sql,
        session(moderator),
        created.result.postId,
        request("POST", { bodyMd: "Moderator edit." }),
      );
      expect(edited.status).toBe(200);

      const [row] = (await database.sql`
        SELECT redacted_at FROM core.quote_snapshots WHERE id = ${snapshot}
      `) as Array<{ redacted_at: Date | null }>;
      expect(row?.redacted_at).toBeInstanceOf(Date);
    });
  }, 30_000);

  test("soft deletes, restores and hard deletes with permission checks", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const other = await memberId(database, "member-2");
      const moderator = await memberId(database, "super-mod");
      const created = await startTopic(database.sql, {
        actorId: author,
        forumId: offTopic,
        title: "Delete API topic",
        bodyMd: "First.",
      });

      if (!created.ok) {
        throw new Error("Could not create the topic");
      }

      const firstReply = await reply(database.sql, {
        actorId: author,
        topicId: created.result.topicId,
        bodyMd: "Reply.",
      });

      if (!firstReply.ok) {
        throw new Error("Could not reply");
      }

      const denied = await postDeleteResponse(
        database.sql,
        session(other),
        firstReply.result.postId,
        request("POST", { action: "soft" }),
      );
      expect(denied.status).toBe(403);

      const deleted = await postDeleteResponse(
        database.sql,
        session(author),
        firstReply.result.postId,
        request("POST", { action: "soft" }),
      );
      expect(deleted.status).toBe(200);
      expect(
        (
          (await database.sql`
            SELECT visibility FROM core.posts WHERE id = ${firstReply.result.postId}
          `) as Array<{ visibility: string }>
        )[0]?.visibility,
      ).toBe("soft_deleted");

      const restored = await postDeleteResponse(
        database.sql,
        session(moderator),
        firstReply.result.postId,
        request("POST", { action: "restore" }),
      );
      expect(restored.status).toBe(200);

      const hardDenied = await postDeleteResponse(
        database.sql,
        session(author),
        firstReply.result.postId,
        request("POST", { action: "hard" }),
      );
      expect(hardDenied.status).toBe(403);

      const hard = await postDeleteResponse(
        database.sql,
        session(moderator),
        firstReply.result.postId,
        request("POST", { action: "hard" }),
      );
      expect(hard.status).toBe(200);
    });
  }, 30_000);

  test("history denies private, held and deleted posts", async () => {
    await withSeededDb(async (database) => {
      const staff = await forumId(database, "staff-room");
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const moderator = await memberId(database, "super-mod");
      const other = await memberId(database, "member-2");

      const privateTopic = await startTopic(database.sql, {
        actorId: moderator,
        forumId: staff,
        title: "Private history",
        bodyMd: "Private body.",
      });

      if (!privateTopic.ok) {
        throw new Error("Could not create the private topic");
      }

      expect(
        (await postHistoryResponse(database.sql, session(other), privateTopic.result.postId))
          .status,
      ).toBe(403);

      const heldTopic = await startTopic(database.sql, {
        actorId: author,
        forumId: offTopic,
        title: "Held history",
        bodyMd: "Held body.",
      });

      if (!heldTopic.ok) {
        throw new Error("Could not create the held topic");
      }

      await database.sql`
        UPDATE core.posts SET visibility = 'unapproved' WHERE id = ${heldTopic.result.postId}
      `;
      expect(
        (await postHistoryResponse(database.sql, session(other), heldTopic.result.postId)).status,
      ).toBe(403);

      await database.sql`
        UPDATE core.posts SET visibility = 'soft_deleted' WHERE id = ${heldTopic.result.postId}
      `;
      expect(
        (await postHistoryResponse(database.sql, session(other), heldTopic.result.postId)).status,
      ).toBe(403);
    });
  }, 30_000);

  test("authors lose edit and delete access when forum access is revoked", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const created = await startTopic(database.sql, {
        actorId: author,
        forumId: offTopic,
        title: "Revoked topic",
        bodyMd: "Body.",
      });

      if (!created.ok) {
        throw new Error("Could not create the topic");
      }

      await database.sql`
        UPDATE core.forum_permissions
        SET actions = 0
        WHERE mask_id = (SELECT id FROM core.masks WHERE key = 'standard')
          AND forum_id = (SELECT id FROM core.forums WHERE slug = 'community')
      `;

      expect(
        (
          await editPostResponse(
            database.sql,
            session(author),
            created.result.postId,
            request("POST", { bodyMd: "Changed." }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await postDeleteResponse(
            database.sql,
            session(author),
            created.result.postId,
            request("POST", { action: "soft" }),
          )
        ).status,
      ).toBe(403);
    });
  }, 30_000);

  test("concurrent replies cannot both pass flood control", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const created = await startTopic(database.sql, {
        actorId: author,
        forumId: offTopic,
        title: "Concurrent flood",
        bodyMd: "Body.",
      });

      if (!created.ok) {
        throw new Error("Could not create the topic");
      }

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT id, 'posting.flood_control_seconds', to_jsonb(30)
        FROM core.groups WHERE key = 'members'
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;
      await database.sql`DELETE FROM core.rate_buckets`;

      const attempts = await Promise.all(
        Array.from({ length: 6 }, (_value, index) =>
          replyResponse(
            database.sql,
            session(author),
            created.result.topicId,
            request("POST", { bodyMd: `Concurrent reply ${index}` }),
          ),
        ),
      );
      const statuses = attempts.map((response) => response.status).sort();

      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses.filter((status) => status === 429)).toHaveLength(5);

      await database.sql`DELETE FROM core.rate_buckets`;
      const starts = await Promise.all(
        Array.from({ length: 6 }, (_value, index) =>
          createTopicResponse(
            database.sql,
            session(author),
            offTopic,
            request("POST", { title: `Concurrent start ${index}`, bodyMd: "Body." }),
          ),
        ),
      );
      const startStatuses = starts.map((response) => response.status).sort();
      expect(startStatuses.filter((status) => status === 200)).toHaveLength(1);
      expect(startStatuses.filter((status) => status === 429)).toHaveLength(5);
    });
  }, 30_000);

  test("moderators can edit their own expired posts", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const moderator = await memberId(database, "super-mod");
      const created = await startTopic(database.sql, {
        actorId: moderator,
        forumId: offTopic,
        title: "Moderator old post",
        bodyMd: "Old body.",
      });

      if (!created.ok) {
        throw new Error("Could not create the topic");
      }

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT id, 'posting.edit_window_minutes', to_jsonb(60)
        FROM core.groups WHERE key = 'members'
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;
      await database.sql`
        UPDATE core.posts SET created_at = now() - interval '2 hours'
        WHERE id = ${created.result.postId}
      `;

      expect(
        (
          await editPostResponse(
            database.sql,
            session(moderator),
            created.result.postId,
            request("POST", { bodyMd: "Edited by moderator." }),
          )
        ).status,
      ).toBe(200);
    });
  }, 30_000);

  test("moderators can delete their own posts when author deletion is disabled", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const moderator = await memberId(database, "super-mod");
      const created = await startTopic(database.sql, {
        actorId: moderator,
        forumId: offTopic,
        title: "Moderator delete own",
        bodyMd: "Body.",
      });

      if (!created.ok) {
        throw new Error("Could not create the topic");
      }

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT id, 'posting.can_delete_own', to_jsonb(false) FROM core.groups
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;

      expect(
        (
          await postDeleteResponse(
            database.sql,
            session(moderator),
            created.result.postId,
            request("POST", { action: "soft" }),
          )
        ).status,
      ).toBe(200);
    });
  }, 30_000);

  test("quote checks honour password-forum unlocks", async () => {
    await withSeededDb(async (database) => {
      const general = await forumId(database, "general-discussion");
      const offTopic = await forumId(database, "off-topic");
      const member = await memberId(database, "member-1");
      const [sessionRow] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (${member}, 'user', decode(md5(random()::text), 'hex'), now() + interval '1 day')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (sessionRow === undefined) {
        throw new Error("Could not create the session");
      }

      await database.sql`
        INSERT INTO core.session_grants (session_id, kind, resource_id)
        VALUES (${sessionRow.id}, 'forum_password', ${general})
      `;
      const source = await startTopic(database.sql, {
        actorId: member,
        sessionId: sessionRow.id,
        forumId: general,
        title: "Unlocked quote source",
        bodyMd: "Secret quote source.",
      });

      if (!source.ok) {
        throw new Error(`Could not create the source: ${source.code}`);
      }

      const target = await startTopic(database.sql, {
        actorId: member,
        forumId: offTopic,
        title: "Quote target",
        bodyMd: "Target body.",
      });

      if (!target.ok) {
        throw new Error("Could not create the target");
      }

      const quoteBody = `:::quote{source="post:${source.result.postId}"}
:::

Thanks.`;

      await expect(
        reply(database.sql, {
          actorId: member,
          topicId: target.result.topicId,
          bodyMd: quoteBody,
        }),
      ).rejects.toThrow();

      expect(
        await reply(database.sql, {
          actorId: member,
          topicId: target.result.topicId,
          sessionId: sessionRow.id,
          bodyMd: quoteBody,
        }),
      ).toMatchObject({ ok: true });
    });
  }, 30_000);

  test("restore requires approve for held posts", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const created = await startTopic(database.sql, {
        actorId: author,
        forumId: offTopic,
        title: "Held restore",
        bodyMd: "Held body.",
      });

      if (!created.ok) {
        throw new Error("Could not create the topic");
      }

      await database.sql`
        UPDATE core.posts SET visibility = 'unapproved' WHERE id = ${created.result.postId}
      `;

      const [restoreOnly] = (await database.sql`
        INSERT INTO core.members (display_name) VALUES ('Restore Only') RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (restoreOnly === undefined) {
        throw new Error("Could not create the restore-only member");
      }

      await database.sql`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        SELECT ${restoreOnly.id}, id, true FROM core.groups WHERE key = 'members'
      `;
      await database.sql`
        INSERT INTO core.moderators (forum_id, member_id, powers, this_forum_only)
        VALUES (${offTopic}, ${restoreOnly.id}, '{restore}'::text[], true)
      `;

      expect(
        (
          await postDeleteResponse(
            database.sql,
            session(restoreOnly.id),
            created.result.postId,
            request("POST", { action: "restore" }),
          )
        ).status,
      ).toBe(403);

      expect(
        (
          await postDeleteResponse(
            database.sql,
            session(await memberId(database, "super-mod")),
            created.result.postId,
            request("POST", { action: "restore" }),
          )
        ).status,
      ).toBe(200);

      const [row] = (await database.sql`
        SELECT visibility FROM core.posts WHERE id = ${created.result.postId}
      `) as Array<{ visibility: string }>;
      expect(row?.visibility).toBe("visible");
    });
  }, 30_000);

  test("approving the hundredth held post promotes its author", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const member = await memberId(database, "member-1");
      const moderator = await memberId(database, "super-mod");
      const [groups] = (await database.sql`
        SELECT
          (SELECT id::text FROM core.groups WHERE key = 'members') AS members,
          (SELECT id::text FROM core.groups WHERE key = 'regulars') AS regulars
      `) as Array<{ members: string; regulars: string }>;

      if (groups === undefined) {
        throw new Error("Missing seeded groups");
      }

      await database.sql`
        INSERT INTO core.promotion_rules (from_group_id, to_group_id, criteria, position, enabled)
        VALUES (${groups.members}, ${groups.regulars}, ${{ approved_posts: 100 }}, 0, true)
        ON CONFLICT DO NOTHING
      `;
      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT id, 'posting.flood_control_seconds', to_jsonb(0)
        FROM core.groups WHERE key IN ('members', 'regulars')
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;
      const [bulk] = (await database.sql`
        INSERT INTO core.topics (forum_id, title, slug, starter_id)
        VALUES (${offTopic}, 'Approval bulk', 'approval-bulk', ${member})
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (bulk === undefined) {
        throw new Error("Could not create the bulk topic");
      }

      await database.sql`
        INSERT INTO core.posts (
          topic_id, author_id, body_md, body_html, body_text, render_version,
          sanitiser_version, position
        )
        SELECT ${bulk.id}, ${member}, 'Bulk', '<p>Bulk</p>', 'Bulk', 1, 1, position
        FROM generate_series(1, 99) AS position
      `;

      const held = await startTopic(database.sql, {
        actorId: member,
        forumId: offTopic,
        title: "Held promotion post",
        bodyMd: "Held.",
      });

      if (!held.ok) {
        throw new Error("Could not create the held post");
      }

      await database.sql`
        UPDATE core.posts SET visibility = 'unapproved' WHERE id = ${held.result.postId}
      `;

      expect(
        (
          await postDeleteResponse(
            database.sql,
            session(moderator),
            held.result.postId,
            request("POST", { action: "restore" }),
          )
        ).status,
      ).toBe(200);

      const [promotion] = (await database.sql`
        SELECT g.key AS group_key, m.promotion_version
        FROM core.members m
        JOIN core.member_groups mg ON mg.member_id = m.id AND mg.is_primary
        JOIN core.groups g ON g.id = mg.group_id
        WHERE m.id = ${member}
      `) as Array<{ group_key: string; promotion_version: string }>;
      expect(promotion?.group_key).toBe("regulars");
      expect(promotion?.promotion_version).toBe("1");
    });
  }, 30_000);

  test("a concurrent move cannot change the forum used for reply authorisation", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const staff = await forumId(database, "staff-room");
      const author = await memberId(database, "member-1");
      const created = await startTopic(database.sql, {
        actorId: author,
        forumId: offTopic,
        title: "Move race",
        bodyMd: "Body.",
      });

      if (!created.ok) {
        throw new Error("Could not create the topic");
      }

      const mover = await database.sql.reserve();

      try {
        await mover.unsafe("BEGIN");
        await mover`UPDATE core.topics SET forum_id = ${staff} WHERE id = ${created.result.topicId}`;
        const pending = replyResponse(
          database.sql,
          session(author),
          created.result.topicId,
          request("POST", { bodyMd: "Raced reply." }),
        );

        await Bun.sleep(100);
        await mover.unsafe("COMMIT");
        const response = await pending;

        expect(response.status).toBe(403);
      } finally {
        await mover.unsafe("ROLLBACK").catch(() => undefined);
        await mover.release();
      }
    });
  }, 30_000);

  test("guests can read public history but not when the board setting is off", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const created = await startTopic(database.sql, {
        actorId: author,
        forumId: offTopic,
        title: "Guest history",
        bodyMd: "First version.",
      });

      if (!created.ok) {
        throw new Error("Could not create the topic");
      }

      await editPostResponse(
        database.sql,
        session(author),
        created.result.postId,
        request("POST", { bodyMd: "Second version." }),
      );
      await database.sql`UPDATE core.board_settings SET public_edit_history = true WHERE id = 1`;

      const guest = await postHistoryResponse(database.sql, null, created.result.postId);
      expect(guest.status).toBe(200);
      const payload = (await guest.json()) as { revisions: unknown[] };
      expect(payload.revisions.length).toBeGreaterThan(0);

      await database.sql`UPDATE core.board_settings SET public_edit_history = false WHERE id = 1`;
      expect((await postHistoryResponse(database.sql, null, created.result.postId)).status).toBe(
        401,
      );
    });
  }, 30_000);

  test("promotes a member exactly once when the approved post count reaches the rule", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const member = await memberId(database, "member-1");
      const [groups] = (await database.sql`
        SELECT
          (SELECT id::text FROM core.groups WHERE key = 'members') AS members,
          (SELECT id::text FROM core.groups WHERE key = 'regulars') AS regulars
      `) as Array<{ members: string; regulars: string }>;

      if (groups === undefined) {
        throw new Error("Missing seeded groups");
      }

      await database.sql`
        INSERT INTO core.promotion_rules (from_group_id, to_group_id, criteria, position, enabled)
        VALUES (${groups.members}, ${groups.regulars}, ${{ approved_posts: 100 }}, 0, true)
        ON CONFLICT DO NOTHING
      `;
      const [bulkTopic] = (await database.sql`
        INSERT INTO core.topics (forum_id, title, slug, starter_id)
        VALUES (${offTopic}, 'Bulk count topic', 'bulk-count-topic', ${member})
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (bulkTopic === undefined) {
        throw new Error("Could not create the bulk topic");
      }

      await database.sql`
        INSERT INTO core.posts (
          topic_id, author_id, body_md, body_html, body_text, render_version,
          sanitiser_version, position
        )
        SELECT
          ${bulkTopic.id}, ${member}, 'Bulk post', '<p>Bulk post</p>', 'Bulk post', 1, 1,
          position
        FROM generate_series(1, 99) AS position
      `;
      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT id, 'posting.flood_control_seconds', to_jsonb(0)
        FROM core.groups WHERE key IN ('members', 'regulars')
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;

      const created = await createTopicResponse(
        database.sql,
        session(member),
        offTopic,
        request("POST", { title: "Promotion topic", bodyMd: "Hundredth post." }),
      );
      expect(created.status).toBe(200);

      const [promotion] = (await database.sql`
        SELECT g.key AS group_key, m.promotion_version
        FROM core.members m
        JOIN core.member_groups mg ON mg.member_id = m.id AND mg.is_primary
        JOIN core.groups g ON g.id = mg.group_id
        WHERE m.id = ${member}
      `) as Array<{ group_key: string; promotion_version: string }>;
      expect(promotion?.group_key).toBe("regulars");
      expect(promotion?.promotion_version).toBe("1");

      const topic = (await created.json()) as { topicId: string };
      const second = await replyResponse(
        database.sql,
        session(member),
        topic.topicId,
        request("POST", { bodyMd: "One more." }),
      );
      expect(second.status).toBe(200);

      const [after] = (await database.sql`
        SELECT promotion_version FROM core.members WHERE id = ${member}
      `) as Array<{ promotion_version: string }>;
      expect(after?.promotion_version).toBe("1");
    });
  }, 30_000);

  test("a banned, suspended or warned author cannot edit or reply through the API", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");

      await database.sql`
        UPDATE core.group_settings
        SET value = to_jsonb(0)
        WHERE key = 'posting.flood_control_seconds'
      `;

      const created = await startTopic(database.sql, {
        actorId: author,
        forumId: offTopic,
        title: "Editable topic",
        bodyMd: "Original body.",
      });

      if (!created.ok) {
        throw new Error(`Could not start the topic: ${created.code}`);
      }

      const cases = [
        {
          restriction: "banned",
          apply: async () => {
            await database.sql`
              INSERT INTO core.member_restrictions (member_id, kind, until)
              VALUES (${author}, 'banned', NULL)
            `;
          },
          code: "posting_suspended",
        },
        {
          restriction: "warning suspension",
          apply: async () => {
            await database.sql`
              INSERT INTO core.member_restrictions (member_id, kind, until)
              VALUES (${author}, 'cannot_post', now() + interval '7 days')
            `;
          },
          code: "posting_suspended",
        },
        {
          restriction: "unacknowledged warning",
          apply: async () => {
            await database.sql`
              INSERT INTO core.warnings (member_id, points, expires_at, ack_required, member_note)
              VALUES (${author}, 1, now() + interval '7 days', true, 'Please read this warning.')
            `;
          },
          code: "acknowledgement_required",
        },
      ] as const;

      for (const scenario of cases) {
        await database.sql`DELETE FROM core.member_restrictions WHERE member_id = ${author}`;
        await database.sql`DELETE FROM core.warnings WHERE member_id = ${author}`;
        await scenario.apply();

        const deniedEdit = await editPostResponse(
          database.sql,
          session(author),
          created.result.postId,
          request("POST", { bodyMd: "Edited around the restriction." }),
        );
        expect(deniedEdit.status).toBe(403);
        expect(await deniedEdit.json()).toEqual({ code: scenario.code });

        const deniedReply = await replyResponse(
          database.sql,
          session(author),
          created.result.topicId,
          request("POST", { bodyMd: "A reply around the restriction." }),
        );
        expect(deniedReply.status).toBe(403);
        expect(await deniedReply.json()).toEqual({ code: scenario.code });

        const [stored] = (await database.sql`
          SELECT body_md FROM core.posts WHERE id = ${created.result.postId}
        `) as Array<{ body_md: string }>;
        expect(stored?.body_md).toBe("Original body.");

        const [replies] = (await database.sql`
          SELECT count(*)::int AS count FROM core.posts WHERE topic_id = ${created.result.topicId}
        `) as Array<{ count: number }>;
        expect(replies?.count).toBe(1);
      }
    });
  }, 30_000);
});
