import { describe, expect, test } from "bun:test";
import { createCdnPurger } from "@bulletin/cache";
import { loadEvent } from "@bulletin/db/events";
import {
  baseSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { createAuthService, createCsrfToken, hashToken } from "@bulletin/domain/auth";
import { displayNameSkeleton } from "@bulletin/domain/member";
import { allForumTags, loadForumTree } from "@bulletin/domain/permissions";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authIssuer, staffOrigin } from "@bulletin/test-utils/urls";
import { SQL } from "bun";
import {
  createStaffApi,
  STAFF_ROUTES,
  type StaffApi,
  type StaffRoute,
} from "../../apps/staff-api/src/api.ts";
import { createCoreEventHandler } from "../../apps/workers/src/core-events.ts";
import { createCdn } from "../../mocks/cdn/src/app.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

const ISSUER = authIssuer();
const STAFF_ORIGIN = staffOrigin();
const STAFF_CLIENT = "bulletin-staff";
const SESSION_SECRET = "test-session-secret";

interface StaffSession {
  readonly cookie: string;
  readonly memberId: string;
  readonly sessionId: string;
}

interface Harness {
  readonly database: TestDatabase;
  readonly api: StaffApi;
  readonly auth: Awaited<ReturnType<typeof createAuthService>>;
  readonly sql: SQL;
  readonly cdn: string;
  readonly forumTags: readonly string[];
  readonly close: () => Promise<void>;
}

function roleUrl(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = "";
  return url.toString();
}

async function createMember(
  database: TestDatabase,
  name: string,
  groups: readonly string[],
): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton, last_active_at)
    VALUES (${name}, ${displayNameSkeleton(name)}, now())
    RETURNING id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error(`Could not create ${name}`);
  }

  for (const [index, key] of groups.entries()) {
    await database.sql`
      INSERT INTO core.member_groups (member_id, group_id, is_primary)
      SELECT ${member.id}, g.id, ${index === 0}
      FROM core.groups g
      WHERE g.key = ${key}
    `;
  }

  return member.id;
}

async function createSession(database: TestDatabase, memberId: string): Promise<StaffSession> {
  const token = crypto.randomUUID();
  const [session] = (await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at, last_auth_at)
    VALUES (
      ${memberId}, 'staff', ${hashToken(token)},
      now() + interval '12 hours', now()
    )
    RETURNING id
  `) as Array<{ id: string }>;

  if (session === undefined) {
    throw new Error("Could not create staff session");
  }

  return { cookie: token, memberId, sessionId: session.id };
}

async function createHarness(database: TestDatabase): Promise<Harness> {
  await runSeeds({
    sql: database.sql,
    registry: new SeedRegistry([
      baseSeedModule,
      permissionFixtureSeedModule,
      groupsSeedModule,
      membersSeedModule,
    ]),
  });

  const forumTags = await allForumTags(database.sql);
  const origin = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("<p>cached guest page</p>", {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, s-maxage=60",
          "surrogate-key": forumTags.join(" "),
        },
      }),
  });
  const cdn = createCdn({ origin: origin.url.origin });
  const cdnServer = Bun.serve({ port: 0, fetch: cdn.handler });
  const cdnBase = `http://127.0.0.1:${cdnServer.port}`;

  const sql = new SQL(roleUrl(database.url, "staff_api"));
  const auth = await createAuthService({
    sql,
    kind: "staff",
    issuer: ISSUER,
    jwksUrl: "http://127.0.0.1:1/jwks.json",
    clientId: STAFF_CLIENT,
    origin: STAFF_ORIGIN,
    sessionSecret: SESSION_SECRET,
    nodeEnv: "test",
    cacheTtlMs: 0,
  });
  const purge = createCdnPurger({ url: `${cdnBase}/purge`, timeoutMs: 2_000 });
  const api = createStaffApi({ auth, sql, purge });

  return {
    database,
    api,
    auth,
    sql,
    cdn: cdnBase,
    forumTags,
    close: async () => {
      await auth.close();
      await sql.close();
      cdnServer.stop(true);
      origin.stop(true);
    },
  };
}

async function call(
  api: StaffApi,
  session: StaffSession,
  routeId: string,
  body: unknown,
): Promise<Response> {
  const route = STAFF_ROUTES.find((candidate) => candidate.id === routeId);

  if (route === undefined) {
    throw new Error(`No route ${routeId}`);
  }

  return callRoute(api, session, route, body);
}

async function callRoute(
  api: StaffApi,
  session: StaffSession,
  route: StaffRoute,
  body: unknown,
): Promise<Response> {
  return api.handle(
    new Request(`http://api.test${route.path}`, {
      method: route.method,
      headers: {
        cookie: `bl_staff=${session.cookie}`,
        origin: STAFF_ORIGIN,
        "x-bulletin-csrf": createCsrfToken(session.sessionId, SESSION_SECRET),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

/** Warms both the origin render and the CDN entry, so a successful purge must show a miss. */
async function warmCdn(cdn: string): Promise<void> {
  const first = await fetch(`${cdn}/warm`);
  const second = await fetch(`${cdn}/warm`);

  expect(first.headers.get("x-cache")).toBe("MISS");
  expect(second.headers.get("x-cache")).toBe("HIT");
}

async function expectCdnPurged(cdn: string): Promise<void> {
  const response = await fetch(`${cdn}/warm`);

  expect(response.headers.get("x-cache")).toBe("MISS");
}

async function visibilityEvents(sql: SQL): Promise<ReadonlyArray<{ id: string; forumId: string }>> {
  const rows = (await sql`
    SELECT id::text AS id, payload_ids
    FROM core.events
    WHERE type = 'forum.visibility.changed'
    ORDER BY id
  `) as Array<{ id: string; payload_ids: string | { forumId?: string } }>;

  return rows.map((row) => {
    const payload =
      typeof row.payload_ids === "string"
        ? (JSON.parse(row.payload_ids) as { forumId?: string })
        : row.payload_ids;

    return { id: row.id, forumId: payload.forumId ?? "" };
  });
}

async function expectRetryEventsCoverEveryForum(
  harness: Harness,
  before: readonly { id: string }[],
): Promise<void> {
  const roots = (await loadForumTree(harness.database.sql)).roots.map((root) => root.id);
  const events = (await visibilityEvents(harness.database.sql)).slice(before.length);

  expect(events.map((event) => event.forumId).sort()).toEqual([...roots].sort());

  const purged = new Set<string>();
  const handler = createCoreEventHandler({
    sql: harness.database.sql,
    purger: {
      async purge(tags) {
        for (const tag of tags) {
          purged.add(tag);
        }

        return { tags, ok: true };
      },
    },
  });

  for (const event of events) {
    const stored = await loadEvent(harness.database.sql, BigInt(event.id));

    if (stored === null) {
      throw new Error(`Missing event ${event.id}`);
    }

    await handler(stored);
  }

  expect([...purged].sort()).toEqual([...harness.forumTags].sort());
}

async function maskId(database: TestDatabase, key: string): Promise<string> {
  const [mask] = (await database.sql`
    SELECT id::text AS id FROM core.masks WHERE key = ${key}
  `) as Array<{ id: string }>;

  if (mask === undefined) {
    throw new Error(`Missing mask ${key}`);
  }

  return mask.id;
}

async function groupId(database: TestDatabase, key: string): Promise<string> {
  const [group] = (await database.sql`
    SELECT id::text AS id FROM core.groups WHERE key = ${key}
  `) as Array<{ id: string }>;

  if (group === undefined) {
    throw new Error(`Missing group ${key}`);
  }

  return group.id;
}

async function forumId(database: TestDatabase, position = 0): Promise<string> {
  const tree = await loadForumTree(database.sql);
  const id = tree.ids[position];

  if (id === undefined) {
    throw new Error("No forum");
  }

  return id;
}

integrationDescribe("CDN purge writers (ADR 0006)", () => {
  test("unlinking the Guests mask purges a warmed CDN and emits retry events", async () => {
    if (adminUrl === undefined) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    await withTestDatabase({ adminUrl, prefix: "cdn_unlink" }, async (database) => {
      const harness = await createHarness(database);

      try {
        const admin = await createMember(database, "Unlink Admin", ["administrators"]);
        const session = await createSession(database, admin);
        const before = await visibilityEvents(database.sql);

        await warmCdn(harness.cdn);

        const response = await call(harness.api, session, "masks.update", {
          action: "link",
          groupId: await groupId(database, "guests"),
          maskId: await maskId(database, "guest"),
          linked: false,
        });

        expect(response.status).toBe(200);
        await expectCdnPurged(harness.cdn);
        await expectRetryEventsCoverEveryForum(harness, before);

        const [link] = (await database.sql`
          SELECT 1
          FROM core.group_masks gm
          JOIN core.groups g ON g.id = gm.group_id
          JOIN core.masks m ON m.id = gm.mask_id
          WHERE g.key = 'guests' AND m.key = 'guest'
        `) as unknown[];
        expect(link).toBeUndefined();
      } finally {
        await harness.close();
      }
    });
  }, 30_000);

  test("deleting a mask purges a warmed CDN and emits retry events", async () => {
    if (adminUrl === undefined) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    await withTestDatabase({ adminUrl, prefix: "cdn_delete_mask" }, async (database) => {
      const harness = await createHarness(database);

      try {
        const admin = await createMember(database, "Delete Admin", ["administrators"]);
        const session = await createSession(database, admin);

        expect(
          (
            await call(harness.api, session, "masks.update", {
              action: "save",
              key: "temporary_guest",
              title: "Temporary guest",
              description: "Deleted by the purge regression test",
            })
          ).status,
        ).toBe(200);

        const before = await visibilityEvents(database.sql);
        await warmCdn(harness.cdn);

        const response = await call(harness.api, session, "masks.update", {
          action: "delete",
          id: await maskId(database, "temporary_guest"),
        });

        expect(response.status).toBe(200);
        await expectCdnPurged(harness.cdn);
        await expectRetryEventsCoverEveryForum(harness, before);
      } finally {
        await harness.close();
      }
    });
  }, 30_000);

  test("a matrix cell edit purges its warmed subtree", async () => {
    if (adminUrl === undefined) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    await withTestDatabase({ adminUrl, prefix: "cdn_matrix_cell" }, async (database) => {
      const harness = await createHarness(database);

      try {
        const admin = await createMember(database, "Cell Admin", ["administrators"]);
        const session = await createSession(database, admin);
        const before = await visibilityEvents(database.sql);
        const target = await forumId(database);

        await warmCdn(harness.cdn);

        const response = await call(harness.api, session, "masks.update", {
          action: "cell",
          forumId: target,
          maskId: await maskId(database, "guest"),
          permissionAction: "read",
          allowed: false,
        });

        expect(response.status).toBe(200);
        await expectCdnPurged(harness.cdn);

        const events = (await visibilityEvents(database.sql)).slice(before.length);
        expect(events.map((event) => event.forumId)).toEqual([target]);
      } finally {
        await harness.close();
      }
    });
  }, 30_000);

  test("a bulk matrix edit purges its warmed subtree", async () => {
    if (adminUrl === undefined) {
      throw new Error("TEST_DATABASE_URL is required");
    }

    await withTestDatabase({ adminUrl, prefix: "cdn_matrix_bulk" }, async (database) => {
      const harness = await createHarness(database);

      try {
        const admin = await createMember(database, "Bulk Admin", ["administrators"]);
        const session = await createSession(database, admin);
        const before = await visibilityEvents(database.sql);
        const target = await forumId(database);

        await warmCdn(harness.cdn);

        const response = await call(harness.api, session, "masks.update", {
          action: "bulk",
          forumId: target,
          permissionAction: "read",
          allowed: false,
        });

        expect(response.status).toBe(200);
        await expectCdnPurged(harness.cdn);

        const events = (await visibilityEvents(database.sql)).slice(before.length);
        expect(events.map((event) => event.forumId)).toEqual([target]);
      } finally {
        await harness.close();
      }
    });
  }, 30_000);
});
