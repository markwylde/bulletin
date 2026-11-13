import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  reactionsSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import { createIntegrationApiKey, createPersonalApiKey } from "@bulletin/domain/api";
import { startTopic } from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { handleApiRequest } from "../../apps/user-api/src/api/router.ts";
import { API_ROUTES } from "../../apps/user-api/src/api/routes.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const PEPPER = "public-api-endpoints-test-pepper";
const RATE_SECRET = "public-api-endpoints-test-rate-secret";

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "public_api_endpoints" }, async (database) => {
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
        reactionsSeedModule,
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

function api(
  database: TestDatabase,
  path: string,
  key?: string,
  init: RequestInit = {},
): Promise<Response | null> {
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", "198.51.100.77");

  if (key !== undefined) {
    headers.set("authorization", `Bearer ${key}`);
  }

  return handleApiRequest(new Request(`http://bulletin.localhost${path}`, { ...init, headers }), {
    sql: database.sql,
    routes: API_ROUTES,
    pepper: PEPPER,
    rateLimitSecret: RATE_SECRET,
  });
}

async function json<T>(response: Response | null): Promise<T> {
  if (response === null) {
    throw new Error("Expected an API response");
  }

  return (await response.json()) as T;
}

async function keyFor(
  database: TestDatabase,
  member: string,
  scopes: Parameters<typeof createPersonalApiKey>[1]["scopes"],
): Promise<string> {
  const created = await createPersonalApiKey(database.sql, {
    memberId: member,
    label: "API test key",
    scopes,
    pepper: PEPPER,
  });

  return created.key;
}

interface TopicResult {
  readonly ok: boolean;
  readonly topicId: string;
  readonly postId: string;
  readonly url: string | null;
}

integrationDescribe("public API read endpoints", () => {
  test("describes every registered endpoint in the OpenAPI document", async () => {
    await withSeededDb(async (database) => {
      const response = await api(database, "/api/v1/openapi.json");
      expect(response?.status).toBe(200);
      const document = await json<{
        openapi: string;
        paths: Record<string, Record<string, unknown>>;
      }>(response);

      expect(document.openapi).toBe("3.1.0");

      for (const route of API_ROUTES) {
        const path = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
        expect(document.paths[path]?.[route.method.toLowerCase()]).toBeDefined();
      }
    });
  }, 30_000);

  test("filters every read endpoint by the key's principal", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const staffForum = await forumId(database, "staff-room");
      const publicForum = await forumId(database, "off-topic");
      const staffTopic = await startTopic(database.sql, {
        actorId: admin,
        forumId: staffForum,
        title: "Private staff topic",
        bodyMd: "Staff only body.",
      });
      const publicTopic = await startTopic(database.sql, {
        actorId: admin,
        forumId: publicForum,
        title: "Public API topic",
        bodyMd: "Public body.",
      });

      if (!staffTopic.ok || !publicTopic.ok) {
        throw new Error("Could not create the topics");
      }

      const key = await keyFor(database, member, [
        "read:forums",
        "read:topics",
        "read:posts",
        "read:members",
        "read:search",
      ]);

      // A session cookie on `/api/v1` is ignored: the request is a guest request.
      const guest = await api(database, `/api/v1/topics?forumId=${publicForum}`, undefined, {
        headers: { cookie: "__Host-bl_session=not-a-real-session" },
      });
      expect(guest?.status).toBe(200);

      const forums = await api(database, "/api/v1/forums", key);
      expect(forums?.status).toBe(200);
      const forumTitles = (await json<{ forums: Array<{ title: string }> }>(forums)).forums.map(
        (forum) => forum.title,
      );
      expect(forumTitles).toContain("Off Topic");
      expect(forumTitles).not.toContain("Staff Room");

      expect((await api(database, `/api/v1/forums/${staffForum}`, key))?.status).toBe(404);
      expect((await api(database, `/api/v1/forums/${publicForum}`, key))?.status).toBe(200);

      expect((await api(database, `/api/v1/forums/${staffForum}/topics`, key))?.status).toBe(404);
      const forumTopics = await api(database, `/api/v1/forums/${publicForum}/topics`, key);
      expect(forumTopics?.status).toBe(200);
      expect(
        (await json<{ topics: Array<{ title: string }> }>(forumTopics)).topics.map(
          (topic) => topic.title,
        ),
      ).toContain("Public API topic");

      expect((await api(database, `/api/v1/topics?forumId=${staffForum}`, key))?.status).toBe(404);
      expect((await api(database, `/api/v1/topics?forumId=${publicForum}`, key))?.status).toBe(200);

      expect(
        (await api(database, `/api/v1/topics/${staffTopic.result.topicId}`, key))?.status,
      ).toBe(404);

      const [membersGroup] = (await database.sql`
        SELECT id::text AS id FROM core.groups WHERE key = 'members'
      `) as Array<{ id: string }>;
      const integration = await createIntegrationApiKey(database.sql, {
        label: "Topic Reader Bot",
        groupIds: [membersGroup?.id ?? ""],
        scopes: ["read:topics"],
        pepper: PEPPER,
      });
      expect(
        (await api(database, `/api/v1/topics/${staffTopic.result.topicId}`, integration.key))
          ?.status,
      ).toBe(404);

      const publicRead = await api(database, `/api/v1/topics/${publicTopic.result.topicId}`, key);
      expect(publicRead?.status).toBe(200);
      expect((await json<{ topic: { title: string } }>(publicRead)).topic.title).toBe(
        "Public API topic",
      );

      expect(
        (await api(database, `/api/v1/topics/${staffTopic.result.topicId}/posts`, key))?.status,
      ).toBe(404);
      const posts = await api(database, `/api/v1/topics/${publicTopic.result.topicId}/posts`, key);
      expect(posts?.status).toBe(200);
      expect((await json<{ posts: Array<{ id: string }> }>(posts)).posts).toHaveLength(1);

      expect((await api(database, `/api/v1/posts/${staffTopic.result.postId}`, key))?.status).toBe(
        404,
      );
      expect((await api(database, `/api/v1/posts/${publicTopic.result.postId}`, key))?.status).toBe(
        200,
      );

      const memberRead = await api(database, `/api/v1/members/${member}`, key);
      expect(memberRead?.status).toBe(200);
      expect((await json<{ member: { displayName: string } }>(memberRead)).member.displayName).toBe(
        "Regular Member One",
      );

      const visibleSearch = await api(database, "/api/v1/search?q=Public", key);
      expect(visibleSearch?.status).toBe(200);
      expect((await json<{ items: unknown[] }>(visibleSearch)).items.length).toBeGreaterThan(0);

      const hiddenSearch = await api(database, "/api/v1/search?q=Private", key);
      expect(hiddenSearch?.status).toBe(200);
      expect((await json<{ items: unknown[] }>(hiddenSearch)).items).toHaveLength(0);
    });
  }, 30_000);

  test("does not expose service members through the public member endpoint", async () => {
    await withSeededDb(async (database) => {
      const [membersGroup] = (await database.sql`
        SELECT id::text AS id FROM core.groups WHERE key = 'members'
      `) as Array<{ id: string }>;
      const integration = await createIntegrationApiKey(database.sql, {
        label: "Directory Bot",
        groupIds: [membersGroup?.id ?? ""],
        scopes: ["read:members"],
        pepper: PEPPER,
      });
      const member = await memberId(database, "member-1");
      const key = await keyFor(database, member, ["read:members"]);

      // metadata.id is the key id, not the service member id; resolve the principal instead.
      const [principal] = (await database.sql`
        SELECT principal_member_id::text AS member_id FROM core.api_keys WHERE id = ${integration.metadata.id}
      `) as Array<{ member_id: string }>;
      const serviceRead = await api(database, `/api/v1/members/${principal?.member_id ?? ""}`, key);
      expect(serviceRead?.status).toBe(404);
    });
  }, 30_000);
});

integrationDescribe("public API write endpoints", () => {
  test("creates a topic and reply, reacts and follows through the shared mutations", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const publicForum = await forumId(database, "off-topic");
      const key = await keyFor(database, member, [
        "read:forums",
        "read:topics",
        "read:posts",
        "write:posts",
        "write:reactions",
        "write:follows",
      ]);

      const created = await api(database, `/api/v1/forums/${publicForum}/topics`, key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "API created topic", bodyMd: "Created through the API." }),
      });
      expect(created?.status).toBe(200);
      const topic = await json<TopicResult>(created);
      expect(topic.topicId).toMatch(/^\d+$/);

      // This test is about the write paths, not flood control; start the reply with a clear
      // bucket so the default group interval does not turn it into a 429.
      await database.sql`DELETE FROM core.rate_buckets`;

      const reply = await api(database, `/api/v1/topics/${topic.topicId}/replies`, key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bodyMd: "Reply through the API." }),
      });
      expect(reply?.status).toBe(200);

      const adminTopic = await startTopic(database.sql, {
        actorId: admin,
        forumId: publicForum,
        title: "Reaction target",
        bodyMd: "React to me.",
      });

      if (!adminTopic.ok) {
        throw new Error("Could not create the reaction target");
      }

      const [reaction] = (await database.sql`
        SELECT id::text AS id FROM core.reactions WHERE key = 'like'
      `) as Array<{ id: string }>;
      const reacted = await api(
        database,
        `/api/v1/posts/${adminTopic.result.postId}/reactions`,
        key,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reactionId: reaction?.id ?? "" }),
        },
      );
      expect(reacted?.status).toBe(200);

      const followed = await api(database, "/api/v1/follows", key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "topic", id: topic.topicId, following: true }),
      });
      expect(followed?.status).toBe(200);
      expect(await json<{ following: boolean }>(followed)).toEqual({
        ok: true,
        following: true,
      });

      const [follow] = (await database.sql`
        SELECT 1 FROM core.followed_topics
        WHERE member_id = ${member} AND topic_id = ${topic.topicId}
      `) as unknown[];
      expect(follow).toBeDefined();

      const unfollowed = await api(database, "/api/v1/follows", key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "topic", id: topic.topicId, following: false }),
      });
      expect(unfollowed?.status).toBe(200);
    });
  }, 30_000);

  test("denies writes without the scope and without forum permission, and enforces flood control", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const publicForum = await forumId(database, "off-topic");
      const staffForum = await forumId(database, "staff-room");
      const readKey = await keyFor(database, member, ["read:forums", "read:topics"]);

      const noScope = await api(database, `/api/v1/forums/${publicForum}/topics`, readKey, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "No scope", bodyMd: "Denied." }),
      });
      expect(noScope?.status).toBe(403);

      const writeKey = await keyFor(database, member, [
        "read:forums",
        "read:topics",
        "write:posts",
      ]);

      const denied = await api(database, `/api/v1/forums/${staffForum}/topics`, writeKey, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Private write", bodyMd: "Denied." }),
      });
      expect(denied?.status).toBe(403);

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        SELECT id, 'posting.flood_control_seconds', to_jsonb(30)
        FROM core.groups WHERE key = 'members'
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;
      await database.sql`DELETE FROM core.rate_buckets`;

      const first = await api(database, `/api/v1/forums/${publicForum}/topics`, writeKey, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Flood API topic", bodyMd: "First." }),
      });
      expect(first?.status).toBe(200);
      const topic = await json<TopicResult>(first);

      const tooFast = await api(database, `/api/v1/topics/${topic.topicId}/replies`, writeKey, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bodyMd: "Too fast." }),
      });
      expect(tooFast?.status).toBe(429);
      const retry = await json<{ code: string; retryAfterSeconds: number }>(tooFast);
      expect(retry.code).toBe("flood_control");
      expect(retry.retryAfterSeconds).toBeGreaterThan(0);
    });
  }, 30_000);

  test("refuses to follow content the service member cannot read", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const staffForum = await forumId(database, "staff-room");
      const staffTopic = await startTopic(database.sql, {
        actorId: admin,
        forumId: staffForum,
        title: "Hidden follow target",
        bodyMd: "Staff only.",
      });

      if (!staffTopic.ok) {
        throw new Error("Could not create the topic");
      }

      const [membersGroup] = (await database.sql`
        SELECT id::text AS id FROM core.groups WHERE key = 'members'
      `) as Array<{ id: string }>;
      const integration = await createIntegrationApiKey(database.sql, {
        label: "Follow Bot",
        groupIds: [membersGroup?.id ?? ""],
        scopes: ["read:topics", "write:follows"],
        pepper: PEPPER,
      });

      const denied = await api(database, "/api/v1/follows", integration.key, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "topic",
          id: staffTopic.result.topicId,
          following: true,
        }),
      });
      expect(denied?.status).toBe(404);
      expect(await json<{ code: string }>(denied)).toEqual({ code: "not_found" });
    });
  }, 30_000);
});
