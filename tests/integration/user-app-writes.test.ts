import { describe, expect, test } from "bun:test";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

/**
 * The allowed write set for `user_app`: UNLOGGED processing buffers only (ADR 0001). The
 * template-failure report is queued in a buffer and forwarded by workers; `user_app` never
 * writes the durable audit log.
 */
const ALLOWED_WRITES = ["presence", "system_audit_buffer", "topic_view_buffer"];

function userAppUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl);
  url.username = "user_app";
  url.password = "";
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/** Bun wraps Postgres errors; the SQLSTATE can live in `code`, `errno` or the message. */
async function denied(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    const candidate = error as { code?: string; errno?: string; message?: string };
    return [candidate.code, candidate.errno, candidate.message].filter(Boolean).join("|");
  }

  return "allowed";
}

integrationDescribe("user_app database role", () => {
  test("writes only the UNLOGGED read-path buffers", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase(
      { adminUrl, prefix: "user_app_writes" },
      async (database: TestDatabase) => {
        const sql = new SQL(userAppUrl(adminUrl, database.name));

        try {
          // The read pool can read content.
          expect(
            ((await sql`SELECT count(*)::int AS count FROM core.members`) as unknown[]).length,
          ).toBe(1);

          // The allowed read-path buffers are writable.
          await sql`INSERT INTO core.presence (viewer_key, location) VALUES ('member:1', 'forum:2')`;
          await sql`
          INSERT INTO core.topic_view_buffer (topic_id, viewer_key, bucket)
          VALUES (1, 'member:1', now())
        `;
          // Writes outside the buffers are denied by role grants.
          expect(
            await denied(() => sql`INSERT INTO core.members (display_name) VALUES ('Nope')`),
          ).toContain("42501");
          expect(
            await denied(() => sql`UPDATE core.board_settings SET board_name = 'x' WHERE id = 1`),
          ).toContain("42501");
          expect(await denied(() => sql`DELETE FROM core.themes`)).toContain("42501");
          expect(
            await denied(() => sql`INSERT INTO core.admin_log (action) VALUES ('nope')`),
          ).toContain("42501");
          // The report buffer is append-only: it cannot be read back.
          expect(await denied(() => sql`SELECT count(*) FROM core.system_audit_buffer`)).toContain(
            "42501",
          );
        } finally {
          await sql.close();
        }

        const grants = (await database.sql`
        SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
        WHERE grantee = 'user_app'
          AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
        ORDER BY table_name, privilege_type
      `) as Array<{ table_name: string; privilege_type: string }>;

        expect([...new Set(grants.map((grant) => grant.table_name))].sort()).toEqual(
          ALLOWED_WRITES,
        );
        expect(grants.some((grant) => grant.privilege_type === "DELETE")).toBe(false);
        expect(grants.filter((grant) => grant.table_name === "system_audit_buffer")).toEqual([
          { table_name: "system_audit_buffer", privilege_type: "INSERT" },
        ]);
      },
    );
  }, 20_000);
});
