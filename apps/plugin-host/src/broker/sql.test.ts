import { describe, expect, test } from "bun:test";
import { applyResultLimit, assertAllowedSql, type SqlPolicy } from "./sql.ts";

const policy: SqlPolicy = {
  schema: "plugin_sandbox_demo",
  pluginFunctions: new Set(["note_count"]),
};

async function allowed(sql: string) {
  return assertAllowedSql(sql, policy);
}

async function denied(sql: string, reason?: string) {
  return expect(allowed(sql)).rejects.toThrow(reason);
}

describe("runtime SQL allowlist", () => {
  test("allows SELECT, INSERT, UPDATE and DELETE", async () => {
    expect(await allowed("SELECT id, body FROM notes WHERE id = $1")).toEqual({
      command: "select",
      hasReturning: false,
    });
    expect(await allowed("INSERT INTO notes (body) VALUES ($1) RETURNING id")).toEqual({
      command: "insert",
      hasReturning: true,
    });
    expect(await allowed("UPDATE notes SET body = $1 WHERE id = $2")).toEqual({
      command: "update",
      hasReturning: false,
    });
    expect(await allowed("DELETE FROM notes WHERE id = $1 RETURNING *")).toEqual({
      command: "delete",
      hasReturning: true,
    });
  });

  test("allows the plugin's own schema and its migration functions", async () => {
    await allowed("SELECT * FROM plugin_sandbox_demo.notes");
    await allowed("SELECT note_count()");
    await allowed("SELECT plugin_sandbox_demo.note_count()");
    await allowed("SELECT pg_catalog.count(*) FROM notes");
  });

  test("allows read-only CTEs and subqueries", async () => {
    await allowed(
      "WITH recent AS (SELECT * FROM notes ORDER BY id DESC LIMIT 5) SELECT * FROM recent",
    );
    await allowed("SELECT (SELECT count(*) FROM notes) AS total");
  });

  test("rejects DDL and session commands", async () => {
    for (const sql of [
      "CREATE TABLE notes (id int)",
      "ALTER TABLE notes ADD COLUMN x int",
      "DROP TABLE notes",
      "TRUNCATE notes",
      "CREATE INDEX ON notes (body)",
      "GRANT SELECT ON notes TO some_role",
      "DO $$ BEGIN PERFORM 1; END $$",
      "LISTEN channel",
      "NOTIFY channel, 'x'",
      "UNLISTEN channel",
      "SET ROLE bullet",
      "SET statement_timeout = 0",
      "RESET ALL",
      "COPY notes TO PROGRAM 'id'",
      "COPY notes FROM '/etc/passwd'",
      "EXPLAIN SELECT * FROM notes",
      "CALL some_procedure()",
      "PREPARE p AS SELECT 1",
      "VACUUM notes",
      "LOCK TABLE notes",
      "MERGE INTO notes USING notes AS source ON true WHEN MATCHED THEN DO NOTHING",
      "WITH removed AS (DELETE FROM notes RETURNING *) SELECT * FROM removed",
      "WITH changed AS (UPDATE notes SET body = 'x' RETURNING *) SELECT * FROM changed",
    ]) {
      await denied(sql);
    }
  });

  test("rejects references to core, pii, public and other plugins", async () => {
    for (const sql of [
      "SELECT * FROM core.cache_tags",
      "SELECT * FROM pii.sessions",
      "SELECT * FROM public.notes",
      "SELECT * FROM plugin_other.notes",
      'SELECT * FROM "core".cache_tags',
      "INSERT INTO core.cache_tags (tag) VALUES ('x')",
      "UPDATE core.cache_tags SET tag = 'x'",
      "DELETE FROM pii.sessions",
      "INSERT INTO notes (body) SELECT tag FROM core.cache_tags",
      "WITH x AS (SELECT * FROM core.cache_tags) SELECT * FROM x",
    ]) {
      await denied(sql, "schema");
    }

    await denied("SELECT * FROM bulletin.core.cache_tags", "Cross-database");
  });

  test("rejects side-effecting and unlisted functions", async () => {
    for (const sql of [
      "SELECT pg_sleep(10)",
      "SELECT pg_catalog.pg_sleep(10)",
      "SELECT set_config('search_path', 'core', false)",
      "SELECT pg_notify('channel', 'x')",
      "SELECT pg_terminate_backend(123)",
      "SELECT pg_cancel_backend(123)",
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT pg_ls_dir('/')",
      "SELECT lo_import('/etc/passwd')",
      "SELECT dblink('host=localhost', 'SELECT 1')",
      "SELECT current_setting('search_path')",
      "SELECT pg_advisory_lock(1)",
      "SELECT setval('notes_id_seq', 1)",
      "SELECT unknown_plugin_function()",
    ]) {
      await denied(sql, "Function");
    }
  });

  test("rejects SELECT INTO and row locking", async () => {
    await denied("SELECT * INTO copied FROM notes");
    await denied("SELECT * FROM notes FOR UPDATE");
    await denied("SELECT * FROM notes FOR SHARE");
  });

  test("rejects multiple statements and unparseable input", async () => {
    await denied("SELECT 1; SELECT 2");
    await denied("");
    await denied("SELECT 'unterminated");
  });
});

describe("result-row limiting", () => {
  test("wraps a SELECT with an outer LIMIT", () => {
    expect(
      applyResultLimit(
        "SELECT * FROM notes ORDER BY id DESC;",
        { command: "select", hasReturning: false },
        1000,
      ),
    ).toBe('SELECT * FROM (SELECT * FROM notes ORDER BY id DESC) AS "broker_result" LIMIT 1001');
  });

  test("wraps DML only when it returns rows", () => {
    expect(
      applyResultLimit(
        "INSERT INTO notes (body) VALUES ('x') RETURNING id",
        { command: "insert", hasReturning: true },
        10,
      ),
    ).toBe(
      'WITH "broker_result" AS (INSERT INTO notes (body) VALUES (\'x\') RETURNING id) SELECT * FROM "broker_result" LIMIT 11',
    );

    expect(
      applyResultLimit(
        "UPDATE notes SET body = 'x'",
        { command: "update", hasReturning: false },
        10,
      ),
    ).toBe("UPDATE notes SET body = 'x'");
  });
});
