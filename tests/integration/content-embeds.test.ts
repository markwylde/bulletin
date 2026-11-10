import { describe, expect, test } from "bun:test";
import {
  deleteEmbedProvider,
  listEmbedProviders,
  saveEmbedProvider,
} from "@bulletin/domain/content";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "content_embeds" }, run);
}

integrationDescribe("embed providers", () => {
  test("ships YouTube and Vimeo and applies admin changes", async () => {
    await withDb(async (database) => {
      const defaults = await listEmbedProviders(database.sql);
      expect(defaults.map((provider) => provider.key)).toEqual(["youtube", "vimeo"]);

      const saved = await saveEmbedProvider(database.sql, {
        key: "example",
        title: "Example",
        urlPattern: "^https?://example\\.com/v/(\\w+)$",
        embedUrl: "https://player.example.com/{id}",
        enabled: true,
        position: 5,
      });

      expect(saved.ok).toBe(true);
      expect((await listEmbedProviders(database.sql)).map((provider) => provider.key)).toContain(
        "example",
      );

      await saveEmbedProvider(database.sql, {
        key: "example",
        title: "Example",
        urlPattern: "^https?://example\\.com/v/(\\w+)$",
        embedUrl: "https://player.example.com/{id}",
        enabled: false,
        position: 5,
      });
      expect(
        (await listEmbedProviders(database.sql)).some((provider) => provider.key === "example"),
      ).toBe(false);

      expect(await deleteEmbedProvider(database.sql, "example")).toEqual({ ok: true });
      expect(await deleteEmbedProvider(database.sql, "example")).toEqual({
        ok: false,
        code: "not_found",
      });
    });
  });

  test("rejects an unsafe provider before it reaches the renderer", async () => {
    await withDb(async (database) => {
      const result = await saveEmbedProvider(database.sql, {
        key: "bad",
        title: "Bad",
        urlPattern: "(",
        embedUrl: "http://evil.example/{id}",
      });

      expect(result).toMatchObject({ ok: false, fields: ["urlPattern", "embedUrl"] });
    });
  });
});
