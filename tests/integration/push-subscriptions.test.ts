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
import { PUSH_TEST_KEYS } from "@bulletin/mock-push/test-keys";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import {
  pushDeleteDeviceResponse,
  pushDevicesResponse,
  pushSubscribeResponse,
} from "../../apps/user-api/src/push.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

function roleUrl(database: TestDatabase, role: string): string {
  const url = new URL(database.url);
  url.username = role;
  url.password = "";
  return url.toString();
}

async function withRole(
  database: TestDatabase,
  role: string,
  run: (sql: SQL) => Promise<void>,
): Promise<void> {
  const sql = new SQL(roleUrl(database, role));

  try {
    await run(sql);
  } finally {
    await sql.close();
  }
}

async function seeded(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "push_devices" }, async (database) => {
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

async function sessionToken(database: TestDatabase, memberIdValue: string, token: string) {
  await withRole(database, "user_api", async (sql) => {
    await sql`
      INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
      VALUES (
        ${memberIdValue}, 'user', sha256(convert_to(${token}, 'UTF8')), now() + interval '24 hours'
      )
    `;
  });
}

async function saveDevice(
  database: TestDatabase,
  token: string,
  endpoint = "https://push.example.test/send/alice",
): Promise<string> {
  let deviceId = "";

  await withRole(database, "user_api", async (sql) => {
    const [row] = (await sql`
      SELECT pii.save_push_subscription(
        ${token}, ${endpoint}, ${PUSH_TEST_KEYS.publicKey}, ${PUSH_TEST_KEYS.auth},
        'Alice laptop', 'Chrome/120.0 Safari/537'
      ) AS device_id
    `) as Array<{ device_id: string | null }>;
    deviceId = row?.device_id ?? "";
  });

  return deviceId;
}

async function expectQueryError(query: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  let message = "";

  try {
    await query;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toMatch(pattern);
}

integrationDescribe("push subscriptions", () => {
  test("grants each function only to the role that needs it", async () => {
    await seeded(async (database) => {
      const rows = (await database.sql`
        SELECT r,
          has_function_privilege(
            r, 'pii.save_push_subscription(text, text, text, text, text, text)', 'EXECUTE'
          ) AS can_save,
          has_function_privilege(r, 'pii.list_push_devices(text)', 'EXECUTE') AS can_list,
          has_function_privilege(r, 'pii.delete_push_device(text, bigint)', 'EXECUTE') AS can_delete,
          has_function_privilege(
            r, 'pii.mark_push_subscription_used(bigint, bigint)', 'EXECUTE'
          ) AS can_mark,
          has_function_privilege(
            r, 'pii.delete_dead_push_subscription(bigint, bigint)', 'EXECUTE'
          ) AS can_remove_dead,
          has_table_privilege(r, 'pii.push_subscriptions', 'SELECT') AS can_read_table
        FROM unnest(ARRAY['user_api', 'staff_api', 'user_app', 'workers']) AS r
        ORDER BY r
      `) as Array<{
        r: string;
        can_save: boolean;
        can_list: boolean;
        can_delete: boolean;
        can_mark: boolean;
        can_remove_dead: boolean;
        can_read_table: boolean;
      }>;

      expect(rows).toEqual([
        {
          r: "staff_api",
          can_save: false,
          can_list: false,
          can_delete: false,
          can_mark: false,
          can_remove_dead: false,
          can_read_table: false,
        },
        {
          r: "user_api",
          can_save: true,
          can_list: true,
          can_delete: true,
          can_mark: false,
          can_remove_dead: false,
          can_read_table: false,
        },
        {
          r: "user_app",
          can_save: false,
          can_list: false,
          can_delete: false,
          can_mark: false,
          can_remove_dead: false,
          can_read_table: false,
        },
        {
          r: "workers",
          can_save: false,
          can_list: false,
          can_delete: false,
          can_mark: true,
          can_remove_dead: true,
          can_read_table: false,
        },
      ]);

      await withRole(database, "user_api", async (sql) => {
        await expectQueryError(sql`SELECT * FROM pii.push_subscriptions`, /permission denied/);
      });
    });
  }, 30_000);

  test("lists only metadata and scopes every operation to the session member", async () => {
    await seeded(async (database) => {
      const alice = await memberId(database, "member-1");
      const bob = await memberId(database, "member-2");
      await sessionToken(database, alice, "alice-device-session");
      await sessionToken(database, bob, "bob-device-session");
      const device = await saveDevice(database, "alice-device-session");
      expect(device).toMatch(/^\d+$/);

      await withRole(database, "user_api", async (sql) => {
        const rows = (await sql`
          SELECT row_to_json(device)::text AS row
          FROM pii.list_push_devices('alice-device-session') AS device
        `) as Array<{ row: string }>;

        expect(rows).toHaveLength(1);
        const row = rows[0]?.row ?? "";
        expect(row).toContain("Alice laptop");
        expect(row).toContain("chrome");
        expect(row).not.toContain("push.example.test");
        expect(row).not.toContain(PUSH_TEST_KEYS.publicKey);
        expect(row).not.toContain(PUSH_TEST_KEYS.auth);

        const bobRows = (await sql`
          SELECT device_id FROM pii.list_push_devices('bob-device-session')
        `) as Array<{ device_id: string }>;
        expect(bobRows).toEqual([]);

        const [denied] = (await sql`
          SELECT pii.delete_push_device('bob-device-session', ${device}::bigint) AS deleted
        `) as Array<{ deleted: boolean }>;
        expect(denied?.deleted).toBe(false);

        const [stillThere] = (await sql`
          SELECT count(*)::int AS count FROM pii.list_push_devices('alice-device-session')
        `) as Array<{ count: number }>;
        expect(stillThere?.count).toBe(1);

        const [removed] = (await sql`
          SELECT pii.delete_push_device('alice-device-session', ${device}::bigint) AS deleted
        `) as Array<{ deleted: boolean }>;
        expect(removed?.deleted).toBe(true);
      });
    });
  }, 30_000);

  test("the API returns only device metadata and refuses invalid endpoints", async () => {
    await seeded(async (database) => {
      const alice = await memberId(database, "member-1");
      const bob = await memberId(database, "member-2");
      await sessionToken(database, alice, "alice-api-session");
      await sessionToken(database, bob, "bob-api-session");

      const subscribe = (token: string, endpoint: string): Request =>
        new Request("http://bulletin.localhost/api/push/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: `bl_session=${token}` },
          body: JSON.stringify({
            endpoint,
            keys: { p256dh: PUSH_TEST_KEYS.publicKey, auth: PUSH_TEST_KEYS.auth },
            label: "Alice phone",
          }),
        });

      const invalid = await pushSubscribeResponse(
        database.sql,
        subscribe("alice-api-session", "http://127.0.0.1/push"),
        {
          nodeEnv: "development",
        },
      );
      expect(invalid.status).toBe(400);

      const saved = await pushSubscribeResponse(
        database.sql,
        subscribe("alice-api-session", "https://8.8.8.8/send/device"),
        { nodeEnv: "development" },
      );
      expect(saved.status).toBe(200);
      const savedBody = (await saved.json()) as { deviceId?: string };
      expect(savedBody.deviceId).toMatch(/^\d+$/);

      const list = await pushDevicesResponse(
        database.sql,
        new Request("http://bulletin.localhost/api/push/devices", {
          headers: { cookie: "bl_session=alice-api-session" },
        }),
        "development",
      );
      const listText = await list.text();
      expect(listText).toContain("Alice phone");
      expect(listText).not.toContain("8.8.8.8");
      expect(listText).not.toContain(PUSH_TEST_KEYS.publicKey);
      expect(listText).not.toContain(PUSH_TEST_KEYS.auth);

      const bobDelete = await pushDeleteDeviceResponse(
        database.sql,
        new Request("http://bulletin.localhost/api/push/devices/delete", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: "bl_session=bob-api-session" },
          body: JSON.stringify({ deviceId: savedBody.deviceId }),
        }),
        "development",
      );
      expect(bobDelete.status).toBe(404);

      const aliceDelete = await pushDeleteDeviceResponse(
        database.sql,
        new Request("http://bulletin.localhost/api/push/devices/delete", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: "bl_session=alice-api-session" },
          body: JSON.stringify({ deviceId: savedBody.deviceId }),
        }),
        "development",
      );
      expect(aliceDelete.status).toBe(200);
      expect(bob).not.toBe(alice);
    });
  }, 30_000);

  test("rejects missing or revoked sessions and malformed input", async () => {
    await seeded(async (database) => {
      const alice = await memberId(database, "member-1");
      await sessionToken(database, alice, "alice-live-session");

      await withRole(database, "user_api", async (sql) => {
        const [invalid] = (await sql`
          SELECT pii.save_push_subscription(
            'alice-live-session', '', ${PUSH_TEST_KEYS.publicKey}, ${PUSH_TEST_KEYS.auth},
            'x', 'Chrome/120.0'
          ) AS device_id
        `) as Array<{ device_id: string | null }>;
        expect(invalid?.device_id).toBeNull();

        const [missing] = (await sql`
          SELECT pii.save_push_subscription(
            'not-a-session', 'https://push.example.test/x', ${PUSH_TEST_KEYS.publicKey},
            ${PUSH_TEST_KEYS.auth}, 'x', 'Chrome/120.0'
          ) AS device_id
        `) as Array<{ device_id: string | null }>;
        expect(missing?.device_id).toBeNull();

        const rows = (await sql`
          SELECT count(*)::int AS count FROM pii.list_push_devices('not-a-session')
        `) as Array<{ count: number }>;
        expect(rows[0]?.count).toBe(0);
      });

      await database.sql`
        UPDATE core.sessions SET revoked_at = now()
        WHERE member_id = ${alice}
      `;

      await withRole(database, "user_api", async (sql) => {
        const [revoked] = (await sql`
          SELECT pii.save_push_subscription(
            'alice-live-session', 'https://push.example.test/x', ${PUSH_TEST_KEYS.publicKey},
            ${PUSH_TEST_KEYS.auth}, 'x', 'Chrome/120.0'
          ) AS device_id
        `) as Array<{ device_id: string | null }>;
        expect(revoked?.device_id).toBeNull();
      });
    });
  }, 30_000);
});
