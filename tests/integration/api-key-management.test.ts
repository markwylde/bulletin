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
} from "@bulletin/db/seed";
import { authenticateApiKey } from "@bulletin/domain/api";
import { can } from "@bulletin/domain/permissions";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authorizeStaffRoute, STAFF_ROUTES } from "../../apps/staff-api/src/api.ts";
import {
  integrationKeysResponse,
  mutateIntegrationKeyResponse,
} from "../../apps/staff-api/src/api-keys.ts";
import {
  createPersonalApiKeyResponse,
  personalApiKeysResponse,
  revokePersonalApiKeyResponse,
} from "../../apps/user-api/src/api-keys.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const PEPPER = "api-key-management-pepper";

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "api_key_management" }, async (database) => {
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

function jsonRequest(body: unknown): Request {
  return new Request("http://bulletin.localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

integrationDescribe("personal API keys", () => {
  test("are gated by the group setting and shown once before revocation", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const [group] = (await database.sql`
        SELECT id::text AS id FROM core.groups WHERE key = 'members'
      `) as Array<{ id: string }>;

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${group?.id ?? ""}, 'api.personal_keys', 'false'::jsonb)
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;
      expect(await can(database.sql, member, "create_personal_api_keys")).toBe(false);
      expect((await personalApiKeysResponse(database.sql, member)).status).toBe(404);

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${group?.id ?? ""}, 'api.personal_keys', 'true'::jsonb)
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;
      expect(await can(database.sql, member, "create_personal_api_keys")).toBe(true);

      const created = await createPersonalApiKeyResponse(
        database.sql,
        member,
        jsonRequest({ label: "Personal integration", scopes: ["read:topics"] }),
        PEPPER,
      );
      expect(created.status).toBe(200);
      const body = (await created.json()) as {
        key: string;
        metadata: { id: string; prefix: string };
      };
      expect(body.key).toMatch(/^blt_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
      expect(body.key).toContain(body.metadata.prefix);

      const list = await personalApiKeysResponse(database.sql, member);
      const listed = (await list.json()) as {
        keys: Array<{ prefix: string }>;
        scopes: readonly string[];
      };
      expect(listed.keys).toHaveLength(1);
      expect(listed.keys[0]?.prefix).toBe(body.metadata.prefix);
      expect(listed.scopes).toContain("read:topics");
      expect(JSON.stringify(listed)).not.toContain(body.key.split("_")[2] ?? "");

      expect(
        await authenticateApiKey(database.sql, { key: body.key, pepper: PEPPER }),
      ).not.toBeNull();

      const revoked = await revokePersonalApiKeyResponse(
        database.sql,
        member,
        jsonRequest({ id: body.metadata.id }),
      );
      expect(revoked.status).toBe(200);
      expect(await authenticateApiKey(database.sql, { key: body.key, pepper: PEPPER })).toBeNull();
    });
  }, 30_000);

  test("denies create and revoke while the group setting is off and scopes revocation", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const other = await memberId(database, "member-2");
      const [group] = (await database.sql`
        SELECT id::text AS id FROM core.groups WHERE key = 'members'
      `) as Array<{ id: string }>;

      const created = await createPersonalApiKeyResponse(
        database.sql,
        member,
        jsonRequest({ label: "Revocation target", scopes: ["read:topics"] }),
        PEPPER,
      );
      const createdBody = (await created.json()) as { metadata: { id: string } };
      expect(created.status).toBe(200);

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${group?.id ?? ""}, 'api.personal_keys', 'false'::jsonb)
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;

      const deniedCreate = await createPersonalApiKeyResponse(
        database.sql,
        member,
        jsonRequest({ label: "Denied creation", scopes: ["read:topics"] }),
        PEPPER,
      );
      expect(deniedCreate.status).toBe(404);

      const deniedRevoke = await revokePersonalApiKeyResponse(
        database.sql,
        member,
        jsonRequest({ id: createdBody.metadata.id }),
      );
      expect(deniedRevoke.status).toBe(404);

      const [afterDisabled] = (await database.sql`
        SELECT count(*)::int AS count, count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked
        FROM core.api_keys WHERE principal_member_id = ${member}
      `) as Array<{ count: number; revoked: number }>;
      expect(afterDisabled).toEqual({ count: 1, revoked: 0 });

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${group?.id ?? ""}, 'api.personal_keys', 'true'::jsonb)
        ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value
      `;

      const crossMember = await revokePersonalApiKeyResponse(
        database.sql,
        other,
        jsonRequest({ id: createdBody.metadata.id }),
      );
      expect(crossMember.status).toBe(404);

      const [stillActive] = (await database.sql`
        SELECT revoked_at FROM core.api_keys WHERE id = ${createdBody.metadata.id}
      `) as Array<{ revoked_at: Date | null }>;
      expect(stillActive?.revoked_at).toBeNull();

      const ownRevoke = await revokePersonalApiKeyResponse(
        database.sql,
        member,
        jsonRequest({ id: createdBody.metadata.id }),
      );
      expect(ownRevoke.status).toBe(200);
    });
  }, 30_000);
});

integrationDescribe("integration API keys", () => {
  test("are created as service members, listed without secrets and revoked by staff", async () => {
    await withSeededDb(async (database) => {
      const admin = await memberId(database, "admin");
      const [members] = (await database.sql`
        SELECT id::text AS id FROM core.groups WHERE key = 'members'
      `) as Array<{ id: string }>;

      const view = await integrationKeysResponse(database.sql);
      const options = (await view.json()) as {
        groups: Array<{ id: string; title: string }>;
        scopes: readonly string[];
      };
      expect(options.groups.length).toBeGreaterThan(0);
      expect(options.scopes).toContain("write:posts");

      const stamp = String(Date.now()).slice(-8);
      const created = await mutateIntegrationKeyResponse(
        database.sql,
        admin,
        jsonRequest({
          action: "create",
          label: `Management Bot ${stamp}`,
          groupIds: [members?.id ?? ""],
          scopes: ["read:topics", "write:posts"],
        }),
        PEPPER,
      );
      expect(created.status).toBe(200);
      const body = (await created.json()) as {
        key: string;
        metadata: { id: string; prefix: string; principalName: string };
      };
      expect(body.key).toMatch(/^blt_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
      expect(body.metadata.principalName).toBe(`Management Bot ${stamp}`);

      const list = await integrationKeysResponse(database.sql);
      const listed = (await list.json()) as {
        keys: Array<{ id: string; prefix: string; principalName: string }>;
      };
      const key = listed.keys.find((entry) => entry.id === body.metadata.id);
      expect(key).toMatchObject({
        prefix: body.metadata.prefix,
        principalName: `Management Bot ${stamp}`,
      });
      expect(JSON.stringify(listed)).not.toContain(body.key.split("_")[2] ?? "");

      expect(
        (await authenticateApiKey(database.sql, { key: body.key, pepper: PEPPER }))?.keyKind,
      ).toBe("integration");

      const revoked = await mutateIntegrationKeyResponse(
        database.sql,
        admin,
        jsonRequest({ action: "revoke", id: body.metadata.id }),
        PEPPER,
      );
      expect(revoked.status).toBe(200);
      expect(await authenticateApiKey(database.sql, { key: body.key, pepper: PEPPER })).toBeNull();
    });
  }, 30_000);

  test("requires acp.api", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const route = STAFF_ROUTES.find((entry) => entry.id === "apiKeys.mutate");
      expect(route?.permission).toBe("acp.api");

      if (route === undefined) {
        throw new Error("Missing apiKeys.mutate route");
      }

      const denied = await authorizeStaffRoute(route, {
        request: new Request("http://staff.bulletin.localhost/api/staff/api-keys"),
        url: new URL("http://staff.bulletin.localhost/api/staff/api-keys"),
        session: {
          id: "1",
          memberId: member,
          kind: "staff",
          displayName: "Regular Member One",
          createdAt: new Date(),
          lastSeenAt: new Date(),
          reauthAt: new Date(),
          lastAuthAt: new Date(),
          reauthRetryCount: 0,
          revokedAt: null,
          rotatePending: false,
          viaPreviousToken: false,
          previousTokenExpiresAt: null,
        },
        sql: database.sql,
        checks: [],
      });

      expect(denied.status).toBe(403);
    });
  }, 30_000);
});
