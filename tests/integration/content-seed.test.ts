import { describe, expect, test } from "bun:test";
import { runBaseSeed } from "@bulletin/db/seed";
import type { StorageClient } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

function fakeStorage(): StorageClient & { readonly puts: string[] } {
  const puts: string[] = [];

  return {
    puts,
    async put(key) {
      puts.push(key);
      return 1;
    },
    async get() {
      return new Uint8Array();
    },
    async delete() {},
    presignGet: () => "https://files.test/get",
    presignPut: () => "https://files.test/put",
  };
}

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "content_seed" }, run);
}

integrationDescribe("content seed", () => {
  test("seeds the default emoticon set and renders rules and announcements", async () => {
    await withDb(async (database) => {
      const storage = fakeStorage();
      await runBaseSeed({ databaseUrl: database.url, storage });

      expect(storage.puts.filter((key) => key.startsWith("emoticon/"))).toEqual([
        "emoticon/seed-smile",
        "emoticon/seed-wink",
        "emoticon/seed-sad",
      ]);

      const sets = (await database.sql`
        SELECT key, title, editor_visible FROM core.emoticon_sets
      `) as Array<{ key: string; title: string; editor_visible: boolean }>;
      const emoticons = (await database.sql`
        SELECT code, alt, storage_key FROM core.emoticons ORDER BY position
      `) as Array<{ code: string; alt: string; storage_key: string }>;

      expect(sets).toEqual([{ key: "default", title: "Default emoticons", editor_visible: true }]);
      expect(emoticons.map((emoticon) => emoticon.code)).toEqual(["smile", "wink", "sad"]);
      expect(emoticons.map((emoticon) => emoticon.alt)).toEqual(["Smile", "Wink", "Sad"]);

      const [forum] = (await database.sql`
        SELECT rules, rules_html, rules_text FROM core.forums WHERE id = 2
      `) as Array<{ rules: string; rules_html: string; rules_text: string }>;
      expect(forum?.rules.length).toBeGreaterThan(0);
      expect(forum?.rules_html).toContain("<p>");
      expect(forum?.rules_text).toBe(forum?.rules);

      const announcements = (await database.sql`
        SELECT body, body_html, body_text FROM core.announcements ORDER BY id
      `) as Array<{ body: string; body_html: string; body_text: string }>;
      expect(announcements.length).toBeGreaterThan(0);
      expect(announcements.every((announcement) => announcement.body_html.startsWith("<p>"))).toBe(
        true,
      );
      expect(
        announcements.every((announcement) => announcement.body_text === announcement.body),
      ).toBe(true);
    });
  }, 120_000);
});
