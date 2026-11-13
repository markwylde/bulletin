import { describe, expect, test } from "bun:test";
import { withTestDatabase } from "@bulletin/test-utils/database";
import type { SQL } from "bun";

/**
 * Migration 0115/0121 accidentally re-granted file, large-object and admin built-ins to every
 * application role. 0122 revokes them again and keeps only the functions the app calls
 * (ADR 0011, 0012): `set_config`, `pg_notify` and the advisory-lock family.
 */

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

const APP_ROLES = [
  "bulletin_owner",
  "pii_owner",
  "user_api",
  "staff_api",
  "workers",
  "user_app",
] as const;

/** Every overload of these names must be unreachable from an application role. */
const DENIED = [
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "lo_import",
  "lo_export",
  "lo_create",
  "lo_unlink",
  "lo_get",
  "lo_put",
  "lo_from_bytea",
  "lowrite",
  "loread",
  "lo_open",
  "lo_close",
  "lo_lseek",
  "lo_lseek64",
  "lo_truncate",
  "lo_truncate64",
  "dblink",
  "dblink_connect",
  "dblink_connect_u",
  "dblink_disconnect",
  "dblink_exec",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_create_restore_point",
  "pg_switch_wal",
  "pg_start_backup",
  "pg_stop_backup",
  "pg_backup_start",
  "pg_backup_stop",
  "pg_promote",
] as const;

const ALLOWED = [
  "pg_catalog.set_config(text,text,boolean)",
  "pg_catalog.pg_notify(text,text)",
  "pg_catalog.pg_advisory_lock(bigint)",
  "pg_catalog.pg_advisory_lock(integer,integer)",
  "pg_catalog.pg_advisory_unlock(bigint)",
  "pg_catalog.pg_advisory_xact_lock(bigint)",
  "pg_catalog.pg_advisory_xact_lock_shared(integer,integer)",
  "pg_catalog.pg_try_advisory_lock(bigint)",
  "pg_catalog.pg_try_advisory_xact_lock(integer,integer)",
] as const;

interface FunctionPrivilege {
  readonly proname: string;
  readonly signature: string;
  readonly allowed: boolean;
}

integrationDescribe("application role function grants", () => {
  test("denies file, large-object and admin built-ins to every app role", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_role_grants" }, async (database) => {
      const deniedSignatures = (await database.sql`
        SELECT p.proname, p.oid::regprocedure::text AS signature
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('pg_catalog', 'public')
      `) as Array<{ proname: string; signature: string }>;
      const denied = deniedSignatures.filter((row) =>
        (DENIED as readonly string[]).includes(row.proname),
      );
      expect(denied.length).toBeGreaterThan(0);

      for (const role of APP_ROLES) {
        const rows = (await database.sql`
          SELECT p.proname, p.oid::regprocedure::text AS signature,
            has_function_privilege(${role}, p.oid, 'EXECUTE') AS allowed
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('pg_catalog', 'public')
        `) as FunctionPrivilege[];
        const byName = new Map<string, FunctionPrivilege[]>();

        for (const row of rows) {
          const entries = byName.get(row.proname) ?? [];
          entries.push(row);
          byName.set(row.proname, entries);
        }

        for (const name of DENIED) {
          for (const entry of byName.get(name) ?? []) {
            expect({ role, name, allowed: entry.allowed }).toEqual({
              role,
              name,
              allowed: false,
            });
          }
        }

        for (const signature of ALLOWED) {
          expect({
            role,
            signature,
            allowed: await hasPrivilege(database.sql, role, signature),
          }).toEqual({ role, signature, allowed: true });
        }
      }
    });
  }, 30_000);

  test("denies the built-ins at runtime and allows the functions the app calls", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "plugin_role_runtime" }, async (database) => {
      for (const role of APP_ROLES) {
        for (const statement of [
          "SELECT pg_read_file('/etc/passwd')",
          "SELECT pg_ls_dir('.')",
          "SELECT lo_import('/etc/passwd')",
          "SELECT lo_export(0, '/tmp/exported')",
          "SELECT pg_terminate_backend(pg_backend_pid())",
          "SELECT pg_reload_conf()",
        ]) {
          const run = database.sql.begin(async (transaction) => {
            await transaction.unsafe(`SET LOCAL ROLE ${quoteRole(role)}`);
            return transaction.unsafe(statement);
          });

          await expect(run).rejects.toThrow(/permission denied|must be superuser/i);
        }

        const allowed = await database.sql.begin(async (transaction) => {
          await transaction.unsafe(`SET LOCAL ROLE ${quoteRole(role)}`);
          const [row] = (await transaction.unsafe(`
            SELECT
              set_config('application_name', 'role-grants-test', true) AS config,
              pg_notify('role_grants_test', '1') AS notified,
              pg_advisory_xact_lock(4242) AS locked,
              pg_try_advisory_xact_lock(4243) AS tried
          `)) as Array<Record<string, unknown>>;
          return row;
        });

        // Reaching this point already proves the advisory lock, pg_notify and set_config
        // calls executed as the role; `locked` and `notified` return void.
        expect(allowed?.["config"]).toBe("role-grants-test");
        expect(allowed?.["tried"]).toBe(true);
      }
    });
  }, 30_000);
});

function quoteRole(role: string): string {
  return `"${role.replaceAll('"', '""')}"`;
}

async function hasPrivilege(sql: SQL, role: string, signature: string): Promise<boolean> {
  const rows = (await sql`
    SELECT has_function_privilege(${role}, ${signature}, 'EXECUTE') AS allowed
  `) as Array<{ allowed: boolean }>;
  return rows[0]?.allowed === true;
}
