import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { createPostgresStore } from "./postgres.ts";

// Run inside the compose network (the Postgres port is not published):
//   docker compose exec -T -e BULLETIN_S3_TEST_URL=postgres://bulletin:bulletin@postgres:5432/bulletin \
//     s3 bun test mocks/s3/src/postgres.test.ts

const databaseUrl = Bun.env.BULLETIN_S3_TEST_URL;
const integrationDescribe = databaseUrl === undefined ? describe.skip : describe;

integrationDescribe("Postgres object store", () => {
  test("objects survive a new store instance", async () => {
    if (databaseUrl === undefined) {
      return;
    }

    const key = `test/${crypto.randomUUID()}`;
    const firstSql = new SQL(databaseUrl);
    const first = await createPostgresStore(firstSql);

    await first.put({
      bucket: "bulletin",
      key,
      body: new TextEncoder().encode("persisted"),
      contentType: "text/plain",
    });

    const secondSql = new SQL(databaseUrl);
    const second = await createPostgresStore(secondSql);
    const object = await second.get("bulletin", key);

    expect(object).not.toBeNull();
    expect(new TextDecoder().decode(object?.body)).toBe("persisted");
    expect(object?.contentType).toBe("text/plain");

    await second.delete("bulletin", key);
    await firstSql.close();
    await secondSql.close();
  });
});
