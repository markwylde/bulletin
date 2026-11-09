import { describe, expect, test } from "bun:test";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(
  prefix: string,
  run: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix }, run);
}

/** Bun's SQLQuery is a thenable; asserting rejection on it directly hangs the runner. */
async function expectQueryError(query: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  let message = "";

  try {
    await query;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toMatch(pattern);
}

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

async function createMember(database: TestDatabase, sub: string): Promise<string> {
  let memberId = "";

  await withRole(database, "user_api", async (sql) => {
    const [row] = (await sql`
      SELECT pii.resolve_identity('https://auth.test', ${sub}, ${`${sub}@example.com`}, ${sub})
        AS member_id
    `) as Array<{ member_id: string }>;

    memberId = row?.member_id ?? "";
  });

  if (memberId === "") {
    throw new Error("failed to create member");
  }

  return memberId;
}

integrationDescribe("own session list", () => {
  test("grants the function only to the interactive app roles", async () => {
    await withDb("pii_own_session_grants", async (database) => {
      const rows = (await database.sql`
        SELECT
          r,
          has_function_privilege(r, 'pii.list_own_sessions(text)', 'EXECUTE') AS list_allowed,
          has_function_privilege(r, 'pii.browser_family(text)', 'EXECUTE') AS family_allowed
        FROM unnest(ARRAY['user_app', 'user_api', 'staff_api', 'workers']) AS r
        ORDER BY r
      `) as Array<{ r: string; list_allowed: boolean; family_allowed: boolean }>;

      expect(rows).toEqual([
        { r: "staff_api", list_allowed: true, family_allowed: false },
        { r: "user_api", list_allowed: true, family_allowed: false },
        { r: "user_app", list_allowed: false, family_allowed: false },
        { r: "workers", list_allowed: false, family_allowed: false },
      ]);
    });
  }, 20_000);

  test("returns only the caller's active sessions with IP and browser family", async () => {
    await withDb("pii_own_sessions", async (database) => {
      const alice = await createMember(database, "alice");
      const bob = await createMember(database, "bob");
      const userApi = new SQL(roleUrl(database, "user_api"));

      try {
        const insertSession = async (
          memberId: string,
          token: string,
          options: { readonly revoked?: boolean; readonly idleDays?: number },
        ): Promise<string> => {
          const [row] = (await userApi`
            INSERT INTO core.sessions (
              member_id, kind, token_hash, reauth_at, last_seen_at, revoked_at
            )
            VALUES (
              ${memberId},
              'user',
              sha256(convert_to(${token}, 'UTF8')),
              now() + interval '24 hours',
              now() - make_interval(days => ${options.idleDays ?? 0}),
              CASE WHEN ${options.revoked === true} THEN now() END
            )
            RETURNING id
          `) as Array<{ id: string }>;

          if (row === undefined) {
            throw new Error("failed to create session");
          }

          return row.id;
        };

        const aliceCurrent = await insertSession(alice, "alice-current", {});
        const aliceOther = await insertSession(alice, "alice-other", { idleDays: 2 });
        const aliceRevoked = await insertSession(alice, "alice-revoked", { revoked: true });
        const aliceExpired = await insertSession(alice, "alice-expired", { idleDays: 31 });
        const bobCurrent = await insertSession(bob, "bob-current", {});

        await userApi`
          SELECT pii.record_session_meta(
            ${aliceCurrent}, '203.0.113.1', 'Chrome/120.0 Safari/537'
          )
        `;
        await userApi`
          SELECT pii.record_session_meta(${aliceOther}, '203.0.113.2', 'Firefox/121.0')
        `;
        await userApi`
          SELECT pii.record_session_meta(
            ${aliceRevoked}, '203.0.113.3', 'Chrome/119.0 Safari/537'
          )
        `;
        await userApi`
          SELECT pii.record_session_meta(${aliceExpired}, '203.0.113.4', 'Safari/605.1')
        `;
        await userApi`
          SELECT pii.record_session_meta(
            ${bobCurrent}, '198.51.100.8', 'Edg/120.0 Chrome/120.0 Safari/537'
          )
        `;

        const rows = (await userApi`
          SELECT session_id, kind, is_current, ip, browser_family
          FROM pii.list_own_sessions('alice-current')
          ORDER BY session_id
        `) as Array<{
          session_id: string;
          kind: string;
          is_current: boolean;
          ip: string | null;
          browser_family: string | null;
        }>;

        expect(rows.map((row) => row.session_id).sort()).toEqual([aliceCurrent, aliceOther].sort());
        expect(rows).toEqual(
          expect.arrayContaining([
            {
              session_id: aliceCurrent,
              kind: "user",
              is_current: true,
              ip: "203.0.113.1",
              browser_family: "chrome",
            },
            {
              session_id: aliceOther,
              kind: "user",
              is_current: false,
              ip: "203.0.113.2",
              browser_family: "firefox",
            },
          ]),
        );

        const bobRows = (await userApi`
          SELECT session_id, is_current, ip, browser_family
          FROM pii.list_own_sessions('bob-current')
        `) as Array<{
          session_id: string;
          is_current: boolean;
          ip: string;
          browser_family: string;
        }>;

        expect(bobRows).toEqual([
          {
            session_id: bobCurrent,
            is_current: true,
            ip: "198.51.100.8",
            browser_family: "edge",
          },
        ]);

        for (const token of ["alice-revoked", "alice-expired", "not-a-token", ""]) {
          const empty = (await userApi`
            SELECT count(*)::int AS count FROM pii.list_own_sessions(${token})
          `) as Array<{ count: number }>;
          expect(empty[0]?.count).toBe(0);
        }
      } finally {
        await userApi.close();
      }

      const audits = (await database.sql`
        SELECT actor_member_id, subject_member_id, purpose, resource_type
        FROM pii.access_log
        WHERE purpose = 'own_data'
        ORDER BY id
      `) as Array<Record<string, string>>;

      expect(audits).toEqual([
        {
          actor_member_id: alice,
          subject_member_id: alice,
          purpose: "own_data",
          resource_type: "session",
        },
        {
          actor_member_id: bob,
          subject_member_id: bob,
          purpose: "own_data",
          resource_type: "session",
        },
      ]);

      await withRole(database, "workers", async (sql) => {
        await expectQueryError(
          sql`SELECT * FROM pii.list_own_sessions('alice-current')`,
          /permission denied/,
        );
      });
    });
  }, 20_000);
});
