import { describe, expect, test } from "bun:test";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const APP_ROLES = ["user_app", "user_api", "staff_api", "workers"] as const;
const PII_TABLES = [
  "access_grants",
  "access_log",
  "identities",
  "ip_log",
  "post_ips",
  "push_subscriptions",
  "session_meta",
] as const;

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

integrationDescribe("restricted identity data", () => {
  test("forces RLS on pii tables and denies direct access to app roles", async () => {
    await withDb("pii_rls", async (database) => {
      const tables = (await database.sql`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pii' AND c.relkind = 'r'
        ORDER BY c.relname
      `) as Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;

      expect(tables).toEqual(
        PII_TABLES.map((relname) => ({
          relname,
          relrowsecurity: true,
          relforcerowsecurity: true,
        })),
      );

      const policies = (await database.sql`
        SELECT tablename, roles::text AS roles
        FROM pg_policies
        WHERE schemaname = 'pii'
        ORDER BY tablename
      `) as Array<{ tablename: string; roles: string }>;

      expect(policies).toEqual(
        PII_TABLES.map((tablename) => ({ tablename, roles: "{pii_owner}" })),
      );

      const [privileges] = (await database.sql`
        SELECT
          bool_or(has_table_privilege(r, 'pii.identities', 'SELECT')) AS any_identity_read,
          bool_or(has_table_privilege(r, 'pii.identities', 'INSERT')) AS any_identity_write,
          bool_or(has_table_privilege(r, 'pii.session_meta', 'SELECT')) AS any_session_read,
          bool_or(has_table_privilege(r, 'pii.ip_log', 'SELECT')) AS any_ip_read,
          bool_or(has_table_privilege(r, 'pii.access_log', 'SELECT')) AS any_audit_read,
          bool_or(has_schema_privilege('user_app', 'pii', 'USAGE')) AS app_schema,
          bool_or(has_schema_privilege('user_api', 'pii', 'USAGE')) AS api_schema
        FROM unnest(ARRAY['user_app', 'user_api', 'staff_api', 'workers']) AS r
      `) as Array<Record<string, boolean>>;

      expect(privileges).toMatchObject({
        any_identity_read: false,
        any_identity_write: false,
        any_session_read: false,
        any_ip_read: false,
        any_audit_read: false,
        app_schema: false,
        api_schema: true,
      });

      for (const role of APP_ROLES) {
        await withRole(database, role, async (sql) => {
          await expectQueryError(sql`SELECT * FROM pii.identities LIMIT 1`, /permission denied/);
        });
      }
    });
  }, 15_000);

  test("grants each definer function only to its listed roles", async () => {
    await withDb("pii_grants", async (database) => {
      const rows = (await database.sql`
        SELECT p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'EXECUTE') AS allowed
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN pg_roles r
        WHERE n.nspname = 'pii'
          AND r.rolname IN ('user_app', 'user_api', 'staff_api', 'workers')
        ORDER BY p.proname, r.rolname
      `) as Array<{ proname: string; rolname: string; allowed: boolean }>;

      const allowed = new Map<string, string[]>();

      for (const row of rows.filter((candidate) => candidate.allowed)) {
        allowed.set(row.proname, [...(allowed.get(row.proname) ?? []), row.rolname]);
      }

      expect(allowed.get("resolve_identity")).toEqual(["staff_api", "user_api"]);
      expect(allowed.get("record_session_meta")).toEqual(["staff_api", "user_api"]);
      expect(allowed.get("record_login_ip")).toEqual(["staff_api", "user_api"]);

      const [publicGrants] = (await database.sql`
        SELECT count(*)::int AS count
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
        WHERE n.nspname = 'pii' AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
      `) as Array<{ count: number }>;

      expect(publicGrants?.count).toBe(0);

      await withRole(database, "workers", async (sql) => {
        await expectQueryError(
          sql`SELECT pii.resolve_identity('https://auth.test', 'denied', null, null)`,
          /permission denied/,
        );
      });
    });
  }, 15_000);

  test("resolve_identity creates one member and audits only creation and email changes", async () => {
    await withDb("pii_resolve", async (database) => {
      let memberId = "";
      let repeatedId = "";

      await withRole(database, "user_api", async (sql) => {
        const [created] = (await sql`
          SELECT pii.resolve_identity(
            'https://auth.test', 'first-user', 'first@example.com', 'First User'
          ) AS member_id
        `) as Array<{ member_id: string }>;
        memberId = created?.member_id ?? "";

        const [returned] = (await sql`
          SELECT pii.resolve_identity(
            'https://auth.test', 'first-user', 'first@example.com', 'First User'
          ) AS member_id
        `) as Array<{ member_id: string }>;
        repeatedId = returned?.member_id ?? "";

        await sql`
          SELECT pii.resolve_identity(
            'https://auth.test', 'first-user', 'changed@example.com', 'First User'
          )
        `;
        await sql`
          SELECT pii.resolve_identity(
            'https://auth.test', 'first-user', 'changed@example.com', 'Renamed User'
          )
        `;
      });

      expect(memberId).not.toBe("");
      expect(repeatedId).toBe(memberId);

      const members = (await database.sql`
        SELECT id, display_name, is_service, locale
        FROM core.members
      `) as Array<{
        id: string;
        display_name: string | null;
        is_service: boolean;
        locale: string | null;
      }>;

      expect(members).toEqual([
        { id: memberId, display_name: null, is_service: false, locale: null },
      ]);

      const [identity] = (await database.sql`
        SELECT issuer, sub, email, idp_name
        FROM pii.identities
        WHERE member_id = ${memberId}
      `) as Array<{ issuer: string; sub: string; email: string; idp_name: string }>;

      expect(identity).toEqual({
        issuer: "https://auth.test",
        sub: "first-user",
        email: "changed@example.com",
        idp_name: "Renamed User",
      });

      const audits = (await database.sql`
        SELECT purpose, resource_type, actor_member_id, subject_member_id
        FROM pii.access_log
        ORDER BY id
      `) as Array<Record<string, string>>;

      expect(audits).toEqual([
        {
          purpose: "login",
          resource_type: "identity",
          actor_member_id: memberId,
          subject_member_id: memberId,
        },
        {
          purpose: "login",
          resource_type: "identity",
          actor_member_id: memberId,
          subject_member_id: memberId,
        },
      ]);
    });
  }, 15_000);

  test("keeps whitespace-distinct issuers and subjects on separate members", async () => {
    await withDb("pii_resolve_exact", async (database) => {
      let plain = "";
      let paddedSubject = "";
      let paddedIssuer = "";

      await withRole(database, "user_api", async (sql) => {
        const [first] = (await sql`
          SELECT pii.resolve_identity('https://auth.test', 'admin', null, null) AS member_id
        `) as Array<{ member_id: string }>;
        plain = first?.member_id ?? "";

        const [second] = (await sql`
          SELECT pii.resolve_identity('https://auth.test', ' admin ', null, null) AS member_id
        `) as Array<{ member_id: string }>;
        paddedSubject = second?.member_id ?? "";

        const [third] = (await sql`
          SELECT pii.resolve_identity(' https://auth.test ', 'admin', null, null) AS member_id
        `) as Array<{ member_id: string }>;
        paddedIssuer = third?.member_id ?? "";

        await expectQueryError(
          sql`SELECT pii.resolve_identity('https://auth.test', '   ', null, null)`,
          /issuer and subject are required/,
        );
      });

      expect(new Set([plain, paddedSubject, paddedIssuer]).size).toBe(3);

      const identities = (await database.sql`
        SELECT issuer, sub
        FROM pii.identities
        ORDER BY issuer, sub
      `) as Array<{ issuer: string; sub: string }>;

      expect(identities).toEqual([
        { issuer: " https://auth.test ", sub: "admin" },
        { issuer: "https://auth.test", sub: " admin " },
        { issuer: "https://auth.test", sub: "admin" },
      ]);
    });
  }, 15_000);

  test("session metadata and login IPs are write-only for the app roles", async () => {
    await withDb("pii_write", async (database) => {
      const memberId = await createMember(database, "writer");

      const [session] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (
          ${memberId}, 'user', sha256(convert_to('writer-token', 'UTF8')),
          now() + interval '24 hours'
        )
        RETURNING id
      `) as Array<{ id: string }>;

      if (session === undefined) {
        throw new Error("failed to create session");
      }

      await withRole(database, "user_api", async (sql) => {
        await sql`
          SELECT pii.record_session_meta(
            ${session.id}, '198.51.100.7', 'Mozilla/5.0 Firefox/121.0'
          )
        `;
        await sql`SELECT pii.record_login_ip(${memberId}, '198.51.100.7')`;
      });

      const meta = (await database.sql`
        SELECT session_id, host(ip) AS ip, user_agent
        FROM pii.session_meta
      `) as Array<{ session_id: string; ip: string; user_agent: string }>;

      expect(meta).toEqual([
        {
          session_id: session.id,
          ip: "198.51.100.7",
          user_agent: "Mozilla/5.0 Firefox/121.0",
        },
      ]);

      const logins = (await database.sql`
        SELECT member_id, host(ip) AS ip FROM pii.ip_log
      `) as Array<{ member_id: string; ip: string }>;

      expect(logins).toEqual([{ member_id: memberId, ip: "198.51.100.7" }]);

      await withRole(database, "user_api", async (sql) => {
        await sql`
          SELECT pii.record_session_meta(
            ${session.id}, '203.0.113.9', 'Mozilla/5.0 Chrome/121.0 Safari/537.36'
          )
        `;
      });

      const updated = (await database.sql`
        SELECT host(ip) AS ip, user_agent FROM pii.session_meta WHERE session_id = ${session.id}
      `) as Array<{ ip: string; user_agent: string }>;
      expect(updated).toEqual([
        { ip: "203.0.113.9", user_agent: "Mozilla/5.0 Chrome/121.0 Safari/537.36" },
      ]);

      await withRole(database, "user_app", async (sql) => {
        await expectQueryError(
          sql`SELECT pii.record_session_meta(${session.id}, '203.0.113.9', null)`,
          /permission denied/,
        );
        await expectQueryError(
          sql`SELECT pii.record_login_ip(${memberId}, '203.0.113.9')`,
          /permission denied/,
        );
      });
    });
  }, 15_000);
});
