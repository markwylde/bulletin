import { describe, expect, test } from "bun:test";
import { withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

integrationDescribe("per-file database B", () => {
  test("uses a different clone with different data", async () => {
    if (adminUrl === undefined) {
      return;
    }

    await withTestDatabase({ adminUrl, prefix: "parallel_b" }, async (database) => {
      await database.sql`CREATE TABLE harness_values (value text NOT NULL)`;
      await database.sql`INSERT INTO harness_values (value) VALUES ('from-b')`;

      await Bun.sleep(100);

      const values = (await database.sql`
        SELECT value FROM harness_values ORDER BY value
      `) as Array<{ value: string }>;
      expect(values).toEqual([{ value: "from-b" }]);
    });
  }, 15_000);
});
