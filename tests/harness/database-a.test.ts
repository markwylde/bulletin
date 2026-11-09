import { describe, expect, test } from "bun:test";
import { withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

integrationDescribe("per-file database A", () => {
  test("clones a migrated template and isolates its writes", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "parallel_a" }, async (database) => {
      const migrations = (await database.sql`
        SELECT count(*)::int AS count FROM core.schema_migrations
      `) as Array<{ count: number }>;
      expect(migrations[0]?.count).toBeGreaterThan(0);

      await database.sql`CREATE TABLE harness_values (value text NOT NULL)`;
      await database.sql`INSERT INTO harness_values (value) VALUES ('from-a')`;

      await Bun.sleep(100);

      const values = (await database.sql`
        SELECT value FROM harness_values ORDER BY value
      `) as Array<{ value: string }>;
      expect(values).toEqual([{ value: "from-a" }]);
    });
  }, 15_000);
});
