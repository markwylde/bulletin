import { describe, expect, test } from "bun:test";
import { assertAllowedMigration, MigrationDeniedError } from "./migration.ts";

const POLICY = {
  schema: "plugin_test",
  runtimeRole: "plugin_test",
  ownerRole: "plugin_test_owner",
  pluginFunctions: new Set<string>(),
};

const DEMO_MIGRATION = `
  CREATE TABLE IF NOT EXISTS notes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    body text NOT NULL
  );
  CREATE OR REPLACE FUNCTION note_count() RETURNS bigint
  LANGUAGE sql STABLE AS $$ SELECT count(*) FROM notes $$;
`;

async function denial(sql: string): Promise<MigrationDeniedError> {
  try {
    await assertAllowedMigration(sql, POLICY);
  } catch (error) {
    if (error instanceof MigrationDeniedError) {
      return error;
    }

    throw error;
  }

  throw new Error("Expected the migration to be rejected");
}

describe("plugin migration validation", () => {
  test("accepts the demo migration and ordinary DDL", async () => {
    await expect(assertAllowedMigration(DEMO_MIGRATION, POLICY)).resolves.toBeUndefined();
    await expect(
      assertAllowedMigration(
        `
        CREATE TABLE notes (id bigint, body text);
        CREATE UNIQUE INDEX notes_id ON notes (id);
        CREATE SEQUENCE note_seq;
        INSERT INTO notes (id, body) VALUES (nextval('note_seq'), 'hello');
        ALTER TABLE notes ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
        GRANT SELECT ON notes TO plugin_test;
        `,
        POLICY,
      ),
    ).resolves.toBeUndefined();
  });

  test("allows SQL functions defined later to call each other", async () => {
    await assertAllowedMigration(
      `
      CREATE FUNCTION first() RETURNS bigint LANGUAGE sql AS $$ SELECT second() $$;
      CREATE FUNCTION second() RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
      `,
      POLICY,
    );
  });

  test.each([
    ["session", "SET search_path = core"],
    ["session", "RESET ROLE"],
    ["session", "SET ROLE plugin_test_owner"],
    ["session", "DO $$ BEGIN PERFORM 1; END $$"],
    ["session", "ALTER ROLE plugin_test SET search_path = core"],
    ["session", "ALTER SYSTEM SET work_mem = '1GB'"],
    ["statement", "CREATE EXTENSION IF NOT EXISTS dblink"],
    ["statement", "CREATE SCHEMA other"],
    ["session", "BEGIN"],
    ["statement", "VACUUM notes"],
    ["statement", "CREATE INDEX CONCURRENTLY idx ON notes (body)"],
    ["statement", "CREATE TEMP TABLE scratch (id int)"],
    [
      "statement",
      "CREATE FUNCTION evil() RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN PERFORM 1; END $$",
    ],
    [
      "function",
      "CREATE FUNCTION evil() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_notify('x', 'y'); END $$",
    ],
    [
      "function",
      "CREATE FUNCTION evil() RETURNS void LANGUAGE plpgsql AS $$ BEGIN EXECUTE 'SELECT 1'; END $$",
    ],
  ])("rejects %s: %s", async (reason, sql) => {
    await expect(denial(sql)).resolves.toMatchObject({ reason });
  });

  test("rejects cross-schema tables, functions and grants", async () => {
    await expect(denial("CREATE TABLE core.evil (id int)")).resolves.toMatchObject({
      reason: "schema",
    });
    await expect(denial("SELECT * FROM pii.sessions")).resolves.toMatchObject({ reason: "schema" });
    await expect(denial("GRANT SELECT ON core.members TO plugin_test")).resolves.toMatchObject({
      reason: "schema",
    });
    await expect(denial("GRANT SELECT ON notes TO PUBLIC")).resolves.toMatchObject({
      reason: "statement",
    });
    await expect(denial("GRANT SELECT ON notes TO someone_else")).resolves.toMatchObject({
      reason: "statement",
    });
    await expect(
      denial("CREATE FUNCTION other.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$"),
    ).resolves.toMatchObject({ reason: "schema" });
  });

  test("rejects triggers that call a function the plugin did not define", async () => {
    await expect(
      denial(
        "CREATE TRIGGER t BEFORE INSERT ON notes FOR EACH ROW EXECUTE FUNCTION pg_catalog.pg_notify_trigger()",
      ),
    ).resolves.toMatchObject({ reason: "function" });
  });

  test("rejects function SET clauses and unapproved language", async () => {
    await expect(
      denial(
        "CREATE FUNCTION f() RETURNS int LANGUAGE sql SET search_path = core AS $$ SELECT 1 $$",
      ),
    ).resolves.toMatchObject({ reason: "session" });
    await expect(
      denial("CREATE FUNCTION f() RETURNS int LANGUAGE plpython3u AS $$ return 1 $$"),
    ).resolves.toMatchObject({ reason: "statement" });
  });

  test("rejects empty, oversized and unparseable migrations", async () => {
    await expect(denial("  ")).resolves.toMatchObject({ reason: "statement" });
    await expect(denial("SELECT (")).resolves.toMatchObject({ reason: "parse" });
  });
});
