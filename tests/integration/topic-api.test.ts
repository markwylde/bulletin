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
import { readTopic, reply, startTopic } from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import {
  createTopicResponse,
  editPostResponse,
  postDeleteResponse,
  postHistoryResponse,
  replyResponse,
} from "../../apps/user-api/src/topics.ts";

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
});
