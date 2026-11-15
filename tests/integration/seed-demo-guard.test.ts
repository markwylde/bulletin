import { describe, expect, test } from "bun:test";
import { parseSeedDemo } from "@bulletin/config";
import { runBaseSeed, seedModules } from "@bulletin/db/seed";
import { withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function count(sql: Bun.SQL, table: string): Promise<number> {
  const [row] = (await sql.unsafe(`SELECT count(*)::int AS count FROM ${table}`)) as Array<{
    count: number;
  }>;
  return row?.count ?? -1;
}

describe("seed modules", () => {
  test("the production set holds only board defaults", () => {
    expect(
      seedModules(false)
        .map((module) => module.name)
        .sort(),
    ).toEqual(["base", "emoticons", "reactions", "themes"].sort());
    expect(seedModules(true).length).toBeGreaterThan(seedModules(false).length);
  });
});

integrationDescribe("demo seed guard", () => {
  test("a production config seeds board defaults and no demo content", async () => {
    const issues: string[] = [];
    const demo = parseSeedDemo({}, "production", issues);
    expect(demo).toBe(false);
    expect(issues).toEqual([]);

    await withTestDatabase({ adminUrl: adminUrl ?? "", prefix: "seed_prod" }, async (database) => {
      const result = await runBaseSeed({ databaseUrl: database.url, demo });
      expect(result.ran).toBe(true);

      expect(await count(database.sql, "core.board_settings")).toBe(1);
      expect(await count(database.sql, "core.reactions")).toBeGreaterThan(0);
      expect(await count(database.sql, "core.themes")).toBeGreaterThan(0);

      expect(await count(database.sql, "core.members")).toBe(0);
      expect(await count(database.sql, "core.forums")).toBe(0);
      expect(await count(database.sql, "core.topics")).toBe(0);
      expect(await count(database.sql, "core.posts")).toBe(0);
      expect(await count(database.sql, "core.plugins")).toBe(0);
    });
  });

  test("a development config seeds the demo board", async () => {
    const demo = parseSeedDemo({}, "development", []);
    expect(demo).toBe(true);

    await withTestDatabase({ adminUrl: adminUrl ?? "", prefix: "seed_dev" }, async (database) => {
      await runBaseSeed({ databaseUrl: database.url, demo });
      expect(await count(database.sql, "core.members")).toBeGreaterThan(0);
      expect(await count(database.sql, "core.topics")).toBeGreaterThan(0);
    });
  });
});
