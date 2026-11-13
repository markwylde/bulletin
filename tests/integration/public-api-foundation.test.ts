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
import {
  apiCan,
  authenticateApiKey,
  createIntegrationApiKey,
  createPersonalApiKey,
  listApiKeys,
  markApiKeyUsed,
  parseApiKey,
  revokeApiKey,
} from "@bulletin/domain/api";
import { listMembers } from "@bulletin/domain/member";
import { loadForumTree } from "@bulletin/domain/permissions";
import { startTopic } from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import * as v from "valibot";
import { defineApiRoute } from "../../apps/user-api/src/api/route.ts";
import { handleApiRequest } from "../../apps/user-api/src/api/router.ts";
import { API_ROUTES } from "../../apps/user-api/src/api/routes.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const PEPPER = "public-api-foundation-test-pepper";
const RATE_SECRET = "public-api-foundation-test-rate-secret";

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "public_api" }, async (database) => {
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

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`http://bulletin.localhost${path}`, init);
}

function router(database: TestDatabase, routes = API_ROUTES) {
  return (requestValue: Request) =>
    handleApiRequest(requestValue, {
      sql: database.sql,
      routes,
      pepper: PEPPER,
      rateLimitSecret: RATE_SECRET,
    });
}

const publicTopicsRoute = defineApiRoute({
  method: "GET",
  path: "/api/v1/topics",
  operationId: "testPublicTopics",
  summary: "Test-only guest-safe topic list",
  tags: ["test"],
  auth: "optional",
  scopes: ["read:topics"],
  responses: { 200: { description: "Principal", schema: v.object({ principal: v.string() }) } },
  handler: ({ principal }) =>
    Response.json({
      principal:
        principal.kind === "guest"
          ? "guest"
          : `key:${principal.memberId}:${principal.scopes.join(",")}`,
    }),
});

const writePostRoute = defineApiRoute({
  method: "POST",
  path: "/api/v1/test/posts",
  operationId: "testWritePost",
  summary: "Test-only write route",
  tags: ["test"],
  auth: "required",
  scopes: ["write:posts"],
  body: v.object({ title: v.pipe(v.string(), v.minLength(1)) }),
  responses: { 200: { description: "Created", schema: v.object({ title: v.string() }) } },
  handler: ({ body }) => Response.json({ title: body.title }),
});

const readTopicRoute = defineApiRoute({
  method: "GET",
  path: "/api/v1/test/topics/:id",
  operationId: "testReadTopic",
  summary: "Test-only topic read",
  tags: ["test"],
  auth: "required",
  scopes: ["read:topics"],
  params: v.object({ id: v.pipe(v.string(), v.regex(/^\d+$/)) }),
  responses: {
    200: { description: "Topic", schema: v.object({ forumId: v.string() }) },
  },
  handler: async ({ sql, principal, params }) => {
    const [topic] = (await sql`
      SELECT forum_id::text AS forum_id FROM core.topics WHERE id = ${params.id}
    `) as Array<{ forum_id: string }>;

    if (topic === undefined) {
      return Response.json({ code: "not_found" }, { status: 404 });
    }

    const tree = await loadForumTree(sql);

    if (!(await apiCan(sql, principal, "read", { forumId: topic.forum_id, tree }))) {
      return Response.json({ code: "not_found" }, { status: 404 });
    }

    return Response.json({ forumId: topic.forum_id });
  },
});

const TEST_ROUTES = [publicTopicsRoute, writePostRoute, readTopicRoute] as const;

integrationDescribe("public API keys", () => {
  test("shows a new key once and afterwards exposes only its prefix", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const created = await createPersonalApiKey(database.sql, {
        memberId: member,
        label: "Build server",
        scopes: ["read:forums", "read:topics"],
        pepper: PEPPER,
      });

      expect(created.key).toMatch(/^blt_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
      expect(parseApiKey(created.key)?.prefix).toBe(created.metadata.prefix);

      const listed = await listApiKeys(database.sql, member);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        prefix: created.metadata.prefix,
        label: "Build server",
        scopes: ["read:forums", "read:topics"],
        revokedAt: null,
      });
      expect(JSON.stringify(listed)).not.toContain(created.key.split("_")[2] ?? "");

      const principal = await authenticateApiKey(database.sql, {
        key: created.key,
        pepper: PEPPER,
      });
      expect(principal).toMatchObject({
        memberId: member,
        keyKind: "personal",
        scopes: ["read:forums", "read:topics"],
      });
    });
  }, 30_000);

  test("tracks last use at most once a minute and rejects expired keys", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const created = await createPersonalApiKey(database.sql, {
        memberId: member,
        label: "Last used",
        scopes: ["read:forums"],
        pepper: PEPPER,
      });
      const started = new Date("2026-01-01T00:00:00.000Z");

      await markApiKeyUsed(database.sql, created.metadata.id, started);

      const [first] = (await database.sql`
        SELECT last_used_at FROM core.api_keys WHERE id = ${created.metadata.id}
      `) as Array<{ last_used_at: Date }>;
      expect(first?.last_used_at.toISOString()).toBe(started.toISOString());

      await markApiKeyUsed(database.sql, created.metadata.id, new Date(started.getTime() + 30_000));

      const [second] = (await database.sql`
        SELECT last_used_at FROM core.api_keys WHERE id = ${created.metadata.id}
      `) as Array<{ last_used_at: Date }>;
      expect(second?.last_used_at.toISOString()).toBe(started.toISOString());

      const later = new Date(started.getTime() + 61_000);
      await markApiKeyUsed(database.sql, created.metadata.id, later);
      const [third] = (await database.sql`
        SELECT last_used_at FROM core.api_keys WHERE id = ${created.metadata.id}
      `) as Array<{ last_used_at: Date }>;
      expect(third?.last_used_at.toISOString()).toBe(later.toISOString());

      const expired = await createPersonalApiKey(database.sql, {
        memberId: member,
        label: "Expired",
        scopes: ["read:forums"],
        expiresAt: new Date("2020-01-01T00:00:00.000Z"),
        pepper: PEPPER,
      });
      expect(
        await authenticateApiKey(database.sql, { key: expired.key, pepper: PEPPER }),
      ).toBeNull();
    });
  }, 30_000);

  test("revocation is immediate and integration keys act as service members", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const created = await createPersonalApiKey(database.sql, {
        memberId: member,
        label: "Revocable",
        scopes: ["read:forums"],
        pepper: PEPPER,
      });

      expect(
        await revokeApiKey(database.sql, {
          keyId: created.metadata.id,
          principalMemberId: member,
        }),
      ).toBe(true);
      expect(
        await authenticateApiKey(database.sql, { key: created.key, pepper: PEPPER }),
      ).toBeNull();

      const [membersGroup] = (await database.sql`
        SELECT id::text AS id FROM core.groups WHERE key = 'members'
      `) as Array<{ id: string }>;
      const integration = await createIntegrationApiKey(database.sql, {
        label: "Acme Bot",
        groupIds: [membersGroup?.id ?? ""],
        scopes: ["read:topics"],
        pepper: PEPPER,
      });
      const principal = await authenticateApiKey(database.sql, {
        key: integration.key,
        pepper: PEPPER,
      });

      expect(principal?.keyKind).toBe("integration");
      const [service] = (await database.sql`
        SELECT is_service FROM core.members WHERE id = ${principal?.memberId ?? ""}
      `) as Array<{ is_service: boolean }>;
      expect(service?.is_service).toBe(true);

      const directory = await listMembers(database.sql, {
        query: "",
        groupId: null,
        joinedFrom: null,
        joinedTo: null,
        sort: "name",
        direction: "asc",
        page: 1,
        includeHidden: true,
      });
      expect(directory.members.map((entry) => entry.displayName)).not.toContain("Acme Bot");
    });
  }, 30_000);
});

integrationDescribe("/api/v1 router", () => {
  test("ignores session cookies and allows cross-origin use without credentials", async () => {
    await withSeededDb(async (database) => {
      const handle = router(database, TEST_ROUTES);
      const response = await handle(
        request("/api/v1/topics", {
          headers: {
            cookie: "__Host-bl_session=not-a-real-session",
            origin: "https://third-party.example",
          },
        }),
      );

      expect(response?.status).toBe(200);
      expect(await response?.json()).toEqual({ principal: "guest" });
      expect(response?.headers.get("access-control-allow-origin")).toBe("*");
      expect(response?.headers.get("access-control-allow-credentials")).toBeNull();

      const preflight = await handle(
        request("/api/v1/topics", {
          method: "OPTIONS",
          headers: {
            origin: "https://third-party.example",
            "access-control-request-headers": "authorization",
          },
        }),
      );
      expect(preflight?.status).toBe(204);
      expect(preflight?.headers.get("access-control-allow-origin")).toBe("*");
      expect(preflight?.headers.get("access-control-allow-credentials")).toBeNull();
    });
  }, 30_000);

  test("serves a generated OpenAPI document for every registered route", async () => {
    await withSeededDb(async (database) => {
      const response = await router(database)(request("/api/v1/openapi.json"));
      expect(response?.status).toBe(200);
      const document = (await response?.json()) as {
        openapi: string;
        paths: Record<string, Record<string, unknown>>;
        components: { securitySchemes: Record<string, unknown> };
      };

      expect(document.openapi).toBe("3.1.0");
      expect(Object.keys(document.paths)).toContain("/api/v1/openapi.json");
      expect(document.paths["/api/v1/openapi.json"]?.get).toBeDefined();
      expect(document.components.securitySchemes.bearerAuth).toMatchObject({
        type: "http",
        scheme: "bearer",
      });

      expect(await router(database)(request("/api/board"))).toBeNull();
    });
  }, 30_000);

  test("rejects a revoked key and validates request bodies from the route schema", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const created = await createPersonalApiKey(database.sql, {
        memberId: member,
        label: "Write",
        scopes: ["write:posts"],
        pepper: PEPPER,
      });
      const handle = router(database, TEST_ROUTES);

      const invalid = await handle(
        request("/api/v1/test/posts", {
          method: "POST",
          headers: {
            authorization: `Bearer ${created.key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ title: "" }),
        }),
      );
      expect(invalid?.status).toBe(400);
      expect(await invalid?.json()).toMatchObject({
        code: "validation_failed",
        issues: [{ path: "title" }],
      });

      await revokeApiKey(database.sql, { keyId: created.metadata.id });
      const revoked = await handle(
        request("/api/v1/test/posts", {
          method: "POST",
          headers: {
            authorization: `Bearer ${created.key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ title: "Hello" }),
        }),
      );
      expect(revoked?.status).toBe(401);
      expect(await revoked?.json()).toEqual({ code: "invalid_api_key" });
    });
  }, 30_000);

  test("enforces scopes before the principal's own permissions", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const created = await createPersonalApiKey(database.sql, {
        memberId: member,
        label: "Read only",
        scopes: ["read:forums"],
        pepper: PEPPER,
      });
      const response = await router(
        database,
        TEST_ROUTES,
      )(
        request("/api/v1/test/posts", {
          method: "POST",
          headers: {
            authorization: `Bearer ${created.key}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ title: "No scope" }),
        }),
      );

      expect(response?.status).toBe(403);
      expect(await response?.json()).toEqual({ code: "insufficient_scope" });
    });
  }, 30_000);

  test("never lets an integration key read a forum its service member cannot read", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const staffForum = await forumId(database, "staff-room");
      const publicForum = await forumId(database, "off-topic");
      const created = await startTopic(database.sql, {
        actorId: admin,
        forumId: staffForum,
        title: "Private staff topic",
        bodyMd: "Staff only.",
      });
      const publicTopic = await startTopic(database.sql, {
        actorId: admin,
        forumId: publicForum,
        title: "Public topic",
        bodyMd: "Everyone can read this.",
      });

      if (!created.ok || !publicTopic.ok) {
        throw new Error("Could not create the topics");
      }

      const [membersGroup] = (await database.sql`
        SELECT id::text AS id FROM core.groups WHERE key = 'members'
      `) as Array<{ id: string }>;
      const key = await createIntegrationApiKey(database.sql, {
        label: "Read Bot",
        groupIds: [membersGroup?.id ?? ""],
        scopes: ["read:topics"],
        pepper: PEPPER,
      });
      const handle = router(database, TEST_ROUTES);

      const denied = await handle(
        request(`/api/v1/test/topics/${created.result.topicId}`, {
          headers: { authorization: `Bearer ${key.key}` },
        }),
      );
      expect(denied?.status).toBe(404);
      expect(await denied?.json()).toEqual({ code: "not_found" });

      const allowed = await handle(
        request(`/api/v1/test/topics/${publicTopic.result.topicId}`, {
          headers: { authorization: `Bearer ${key.key}` },
        }),
      );
      expect(allowed?.status).toBe(200);
    });
  }, 30_000);
});

integrationDescribe("/api/v1 rate limits", () => {
  test("returns quota headers and 429 with Retry-After for an exhausted key", async () => {
    await withSeededDb(async (database) => {
      await database.sql`
        UPDATE core.board_settings
        SET api_key_rate_limit_per_minute = 1, api_ip_rate_limit_per_minute = 100
        WHERE id = 1
      `;
      await database.sql`DELETE FROM core.rate_buckets`;

      const member = await memberId(database, "member-1");
      const created = await createPersonalApiKey(database.sql, {
        memberId: member,
        label: "Limited",
        scopes: ["read:topics"],
        pepper: PEPPER,
      });
      const handle = router(database, TEST_ROUTES);
      const first = await handle(
        request("/api/v1/topics", {
          headers: {
            authorization: `Bearer ${created.key}`,
            "x-forwarded-for": "203.0.113.10",
          },
        }),
      );
      expect(first?.status).toBe(200);
      expect(first?.headers.get("ratelimit-limit")).toBe("1");
      expect(first?.headers.get("ratelimit-remaining")).toBe("0");

      const second = await handle(
        request("/api/v1/topics", {
          headers: {
            authorization: `Bearer ${created.key}`,
            "x-forwarded-for": "203.0.113.11",
          },
        }),
      );
      expect(second?.status).toBe(429);
      expect(second?.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(second?.headers.get("ratelimit-remaining")).toBe("0");
      expect(await second?.json()).toEqual({ code: "rate_limited" });
    });
  }, 30_000);

  test("counts invalid keys against the IP limit before authentication", async () => {
    await withSeededDb(async (database) => {
      await database.sql`
        UPDATE core.board_settings
        SET api_key_rate_limit_per_minute = 100, api_ip_rate_limit_per_minute = 1
        WHERE id = 1
      `;
      await database.sql`DELETE FROM core.rate_buckets`;

      const handle = router(database, TEST_ROUTES);
      const first = await handle(
        request("/api/v1/topics", {
          headers: {
            authorization: "Bearer blt_deadbeef_not-a-real-key",
            "x-forwarded-for": "203.0.113.50",
          },
        }),
      );
      expect(first?.status).toBe(401);
      expect(first?.headers.get("ratelimit-limit")).toBe("1");

      const second = await handle(
        request("/api/v1/topics", {
          headers: {
            authorization: "Bearer blt_deadbeef_not-a-real-key",
            "x-forwarded-for": "203.0.113.50",
          },
        }),
      );
      expect(second?.status).toBe(429);
      expect(second?.headers.get("retry-after")).toMatch(/^\d+$/);
    });
  }, 30_000);

  test("counts a key before request validation", async () => {
    await withSeededDb(async (database) => {
      await database.sql`
        UPDATE core.board_settings
        SET api_key_rate_limit_per_minute = 1, api_ip_rate_limit_per_minute = 100
        WHERE id = 1
      `;
      await database.sql`DELETE FROM core.rate_buckets`;

      const member = await memberId(database, "member-1");
      const created = await createPersonalApiKey(database.sql, {
        memberId: member,
        label: "Validation-limited",
        scopes: ["write:posts"],
        pepper: PEPPER,
      });
      const handle = router(database, TEST_ROUTES);
      const invalid = await handle(
        request("/api/v1/test/posts", {
          method: "POST",
          headers: {
            authorization: `Bearer ${created.key}`,
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.51",
          },
          body: JSON.stringify({}),
        }),
      );
      expect(invalid?.status).toBe(400);

      const denied = await handle(
        request("/api/v1/test/posts", {
          method: "POST",
          headers: {
            authorization: `Bearer ${created.key}`,
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.52",
          },
          body: JSON.stringify({ title: "Valid" }),
        }),
      );
      expect(denied?.status).toBe(429);
    });
  }, 30_000);

  test("limits guests per IP even without a key", async () => {
    await withSeededDb(async (database) => {
      await database.sql`
        UPDATE core.board_settings
        SET api_key_rate_limit_per_minute = 100, api_ip_rate_limit_per_minute = 1
        WHERE id = 1
      `;
      await database.sql`DELETE FROM core.rate_buckets`;

      const handle = router(database, TEST_ROUTES);
      const first = await handle(
        request("/api/v1/topics", { headers: { "x-forwarded-for": "198.51.100.20" } }),
      );
      expect(first?.status).toBe(200);

      const second = await handle(
        request("/api/v1/topics", { headers: { "x-forwarded-for": "198.51.100.20" } }),
      );
      expect(second?.status).toBe(429);
      expect(second?.headers.get("ratelimit-limit")).toBe("1");
      expect(second?.headers.get("retry-after")).toMatch(/^\d+$/);
    });
  }, 30_000);
});
