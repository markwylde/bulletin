import { describe, expect, test } from "bun:test";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";

/**
 * The restricted-data boundary (ADR 0012; privacy-gdpr task 1.2). No application role may
 * touch a `pii` table directly or execute a `pii` function it was not granted. This sweep is
 * intentionally data-driven: new tables and functions are covered without editing the test.
 */

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const APP_ROLES = ["user_app", "user_api", "staff_api", "workers"] as const;

async function withDb(
  prefix: string,
  run: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix }, run);
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

async function expectDenied(query: PromiseLike<unknown>): Promise<void> {
  let message = "";

  try {
    await query;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }

  expect(message).toMatch(/permission denied/i);
}

interface TableRow {
  readonly relname: string;
  readonly role: string;
  readonly allowed: boolean;
}

interface FunctionRow {
  readonly proname: string;
  readonly signature: string;
  readonly args: string | null;
  readonly role: string;
  readonly allowed: boolean;
}

integrationDescribe("restricted-data access boundary", () => {
  test("every app role is denied direct access to every pii table", async () => {
    await withDb("pii_table_denial", async (database) => {
      const rows = (await database.sql`
        SELECT c.relname, r.rolname AS role,
          bool_or(
            has_table_privilege(r.oid, c.oid, 'SELECT')
            OR has_table_privilege(r.oid, c.oid, 'INSERT')
            OR has_table_privilege(r.oid, c.oid, 'UPDATE')
            OR has_table_privilege(r.oid, c.oid, 'DELETE')
            OR has_table_privilege(r.oid, c.oid, 'TRUNCATE')
          ) AS allowed
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN pg_roles r
        WHERE n.nspname = 'pii'
          AND c.relkind IN ('r', 'p')
          AND r.rolname = ANY (${`{${APP_ROLES.join(",")}}`}::text[])
        GROUP BY c.relname, r.rolname
        ORDER BY c.relname, r.rolname
      `) as TableRow[];

      expect(rows.length).toBeGreaterThan(APP_ROLES.length * 7);
      expect(rows.filter((row) => row.allowed)).toEqual([]);

      // A privilege check is not enough: prove the runtime rejects the query too.
      for (const relname of new Set(rows.map((row) => row.relname))) {
        for (const role of APP_ROLES) {
          await withRole(database, role, async (sql) => {
            await expectDenied(sql.unsafe(`SELECT * FROM pii."${relname}" LIMIT 1`));
          });
        }
      }
    });
  }, 60_000);

  test("every app role is denied every pii function it has no grant for", async () => {
    await withDb("pii_function_denial", async (database) => {
      const rows = (await database.sql`
        SELECT p.proname,
          p.oid::regprocedure::text AS signature,
          (SELECT string_agg(format_type(t, NULL), ',') FROM unnest(p.proargtypes) AS t) AS args,
          r.rolname AS role,
          has_function_privilege(r.oid, p.oid, 'EXECUTE') AS allowed
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN pg_roles r
        WHERE n.nspname = 'pii'
          AND p.prorettype <> 'pg_catalog.trigger'::regtype
          AND r.rolname = ANY (${`{${APP_ROLES.join(",")}}`}::text[])
        ORDER BY p.proname, r.rolname
      `) as FunctionRow[];

      expect(rows.length).toBeGreaterThan(APP_ROLES.length * 10);

      for (const row of rows) {
        if (row.allowed) {
          continue;
        }

        const call = `SELECT * FROM pii."${row.proname}"(${
          row.args === null || row.args === ""
            ? ""
            : row.args
                .split(",")
                .map((type) => `NULL::${type.trim()}`)
                .join(", ")
        })`;

        await withRole(database, row.role, async (sql) => {
          await expectDenied(sql.unsafe(call));
        });
      }

      // Every role must be shut out of at least one sensitive function.
      for (const role of APP_ROLES) {
        expect(rows.filter((row) => row.role === role && !row.allowed).length).toBeGreaterThan(0);
      }
    });
  }, 60_000);

  test("keeps pii functions out of PUBLIC and off the read role's schema", async () => {
    await withDb("pii_function_acl", async ({ sql }) => {
      const [publicGrants] = (await sql`
        SELECT count(*)::int AS count
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
        WHERE n.nspname = 'pii' AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
      `) as Array<{ count: number }>;
      expect(publicGrants?.count).toBe(0);

      const [schema] = (await sql`
        SELECT
          has_schema_privilege('user_app', 'pii', 'USAGE') AS user_app_usage,
          has_schema_privilege('user_api', 'pii', 'USAGE') AS user_api_usage,
          has_schema_privilege('staff_api', 'pii', 'USAGE') AS staff_api_usage,
          has_schema_privilege('workers', 'pii', 'USAGE') AS workers_usage
      `) as Array<Record<string, boolean>>;

      expect(schema).toMatchObject({
        user_app_usage: false,
        user_api_usage: true,
        staff_api_usage: true,
        workers_usage: true,
      });
    });
  }, 30_000);
});
