import { describe, expect, test } from "bun:test";
import type { QuoteSnapshotDraft } from "@bulletin/content";
import {
  insertQuoteSnapshot,
  loadQuoteSnapshot,
  type QuoteSourceKey,
  redactQuoteSnapshots,
} from "@bulletin/domain/content";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

function draft(sourceId = "5", sourceKind: QuoteSnapshotDraft["sourceKind"] = "post") {
  return {
    sourceKind,
    sourceId,
    sourceAuthorId: "0",
    bodyMd: "source **markdown**",
    bodyHtml: "<p>source <strong>markdown</strong></p>",
    renderVersion: 1_000_000,
    sanitiserVersion: 1,
  } satisfies QuoteSnapshotDraft;
}

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "content_quotes" }, run);
}

async function createMember(database: TestDatabase): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES ('Quote Author', 'quoteauthor')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error("Could not create member");
  }

  return member.id;
}

async function tagVersion(database: TestDatabase, tag: string): Promise<string | null> {
  const [row] = (await database.sql`
    SELECT version::text AS version FROM core.cache_tags WHERE tag = ${tag}
  `) as Array<{ version: string }>;

  return row?.version ?? null;
}

integrationDescribe("quote snapshots", () => {
  test("inserts, loads and redacts every snapshot of a post", async () => {
    await withDb(async (database) => {
      const author = await createMember(database);
      const source: QuoteSourceKey = { kind: "post", id: "5" };

      const first = await insertQuoteSnapshot(database.sql, {
        ...draft(),
        sourceAuthorId: author,
      });
      const second = await insertQuoteSnapshot(database.sql, {
        ...draft(),
        sourceAuthorId: author,
      });
      const unrelated = await insertQuoteSnapshot(database.sql, {
        ...draft("6"),
        sourceAuthorId: author,
      });

      expect(await loadQuoteSnapshot(database.sql, first)).toMatchObject({
        sourceKind: "post",
        sourceId: "5",
        sourceAuthorId: author,
        bodyMd: "source **markdown**",
        bodyHtml: "<p>source <strong>markdown</strong></p>",
        redactedAt: null,
      });

      expect(await redactQuoteSnapshots(database.sql, source)).toBe(2);
      expect((await loadQuoteSnapshot(database.sql, first))?.redactedAt).toBeInstanceOf(Date);
      expect((await loadQuoteSnapshot(database.sql, second))?.redactedAt).toBeInstanceOf(Date);
      expect((await loadQuoteSnapshot(database.sql, unrelated))?.redactedAt).toBeNull();
      expect(await tagVersion(database, "post:5:snapshots")).toBe("1");
      expect(await tagVersion(database, "post:6:snapshots")).toBeNull();
    });
  });

  test("a second redaction does not bump the tag again", async () => {
    await withDb(async (database) => {
      const author = await createMember(database);
      await insertQuoteSnapshot(database.sql, { ...draft(), sourceAuthorId: author });

      expect(await redactQuoteSnapshots(database.sql, { kind: "post", id: "5" })).toBe(1);
      expect(await redactQuoteSnapshots(database.sql, { kind: "post", id: "5" })).toBe(0);
      expect(await tagVersion(database, "post:5:snapshots")).toBe("1");
    });
  });

  test("conversation snapshots redact without a shared cache tag", async () => {
    await withDb(async (database) => {
      const author = await createMember(database);
      await insertQuoteSnapshot(database.sql, {
        ...draft("8", "message"),
        sourceAuthorId: author,
      });

      expect(await redactQuoteSnapshots(database.sql, { kind: "message", id: "8" })).toBe(1);
      expect(await tagVersion(database, "post:8:snapshots")).toBeNull();
    });
  });
});
