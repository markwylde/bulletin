import { describe, expect, test } from "bun:test";
import type { QuoteSnapshotDraft } from "@bulletin/content";
import {
  currentContentVersions,
  ensureCurrentRendering,
  SANITISER_VERSION,
} from "@bulletin/content";
import {
  CONTENT_RERENDER_CRON,
  CONTENT_RERENDER_QUEUE,
  createContentJobs,
  runContentRerenderJob,
} from "@bulletin/db/jobs";
import {
  insertQuoteSnapshot,
  loadQuoteSnapshot,
  saveEmoticon,
  saveEmoticonSet,
  updateQuoteSnapshotRendering,
} from "@bulletin/domain/content";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import type { PgBoss } from "pg-boss";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "content_versioning" }, run);
}

async function createMember(database: TestDatabase, name = "Version Author"): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${name.toLowerCase().replace(/\s+/g, "")})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error("Could not create member");
  }

  return member.id;
}

function draft(author: string, overrides: Partial<QuoteSnapshotDraft> = {}): QuoteSnapshotDraft {
  return {
    sourceKind: "post",
    sourceId: "5",
    sourceAuthorId: author,
    bodyMd: "safe **markdown**",
    bodyHtml: "<p>safe <strong>markdown</strong></p>",
    ...currentContentVersions(),
    ...overrides,
  };
}

integrationDescribe("content versioning (ADR 0007)", () => {
  test("a stale row is re-sanitised on read before the job reaches it", async () => {
    await withDb(async (database) => {
      const author = await createMember(database);
      const id = await insertQuoteSnapshot(
        database.sql,
        draft(author, {
          bodyHtml: '<p>old</p><img src=x onerror="alert(1)">',
          renderVersion: 1,
          sanitiserVersion: 2,
        }),
      );
      const stored = await loadQuoteSnapshot(database.sql, id);

      if (stored === null) {
        throw new Error("snapshot missing");
      }

      const rendered = await ensureCurrentRendering(stored, { profile: "post" });

      expect(rendered.refreshed).toBe(true);
      expect(rendered.bodyHtml).toContain("<p>old</p>");
      expect(rendered.bodyHtml).not.toContain("onerror");
      expect(rendered.bodyText).toBe("old");

      // The job has not run yet, so the row itself is still the old render.
      expect((await loadQuoteSnapshot(database.sql, id))?.bodyHtml).toContain("onerror");
    });
  });

  test("re-renders stale rows in batches, skips current rows and resumes from the cursor", async () => {
    await withDb(async (database) => {
      const author = await createMember(database);
      const stale = { renderVersion: 1, sanitiserVersion: 2 };

      const first = await insertQuoteSnapshot(database.sql, draft(author, stale));
      const second = await insertQuoteSnapshot(database.sql, draft(author, stale));
      const third = await insertQuoteSnapshot(database.sql, draft(author, stale));
      const fresh = await insertQuoteSnapshot(database.sql, draft(author));
      await updateQuoteSnapshotRendering(database.sql, first, {
        bodyHtml: '<p>old</p><img src=x onerror="alert(1)">',
        ...stale,
      });

      const limited = await runContentRerenderJob(database.sql, {
        batchSize: 1,
        maxBatches: 1,
      });

      expect(limited.rerendered).toBe(1);
      expect(limited.batches).toBe(1);
      expect(limited.lastId).toBe(first);
      expect(limited.cursorKey).toContain("content.render:quote_snapshots:");

      const resumed = await runContentRerenderJob(database.sql, { batchSize: 10 });

      expect(resumed.rerendered).toBe(2);
      expect(resumed.lastId).toBe(third);
      expect((await loadQuoteSnapshot(database.sql, first))?.bodyHtml).not.toContain("onerror");
      expect((await loadQuoteSnapshot(database.sql, second))?.sanitiserVersion).toBe(
        SANITISER_VERSION,
      );
      expect((await loadQuoteSnapshot(database.sql, third))?.renderVersion).toBe(
        currentContentVersions().renderVersion,
      );
      expect((await loadQuoteSnapshot(database.sql, fresh))?.sanitiserVersion).toBe(
        currentContentVersions().sanitiserVersion,
      );

      const [cursor] = (await database.sql`
        SELECT last_event_id::text AS last_event_id
        FROM core.job_cursors
        WHERE subscriber = ${resumed.cursorKey}
      `) as Array<{ last_event_id: string }>;
      expect(cursor?.last_event_id).toBe(third);
    });
  });

  test("an upgrade re-render keeps mentions and emoticons", async () => {
    await withDb(async (database) => {
      const author = await createMember(database);
      const jane = await createMember(database, "Jane");
      const set = await saveEmoticonSet(database.sql, {
        key: "default",
        title: "Default",
        position: 0,
        editorVisible: true,
      });

      if (!set.ok || set.id === undefined) {
        throw new Error("Could not create emoticon set");
      }

      const emoticon = await saveEmoticon(database.sql, {
        setId: set.id,
        code: "smile",
        alt: "Smile",
        storageKey: "emoticon/smile",
        contentType: "image/png",
        position: 0,
      });

      if (!emoticon.ok) {
        throw new Error("Could not create emoticon");
      }

      const id = await insertQuoteSnapshot(
        database.sql,
        draft(author, {
          bodyMd: "Hi @Jane, enjoy :smile:",
          bodyHtml: "<p>Hi @Jane, enjoy :smile:</p>",
          renderVersion: 1,
          sanitiserVersion: 2,
        }),
      );

      // The worker registers no render options at startup; the job loads them itself.
      const result = await runContentRerenderJob(database.sql);
      expect(result.rerendered).toBe(1);

      const stored = await loadQuoteSnapshot(database.sql, id);

      expect(stored?.bodyHtml).toContain(`href="/profile/${jane}-jane"`);
      expect(stored?.bodyHtml).toContain(">@Jane</a>");
      expect(stored?.bodyHtml).toContain('class="emoticon"');
      expect(stored?.bodyHtml).toContain('alt="Smile"');
      expect(stored?.bodyHtml).not.toContain("@Jane, enjoy :smile:");
      expect(stored?.renderVersion).toBe(currentContentVersions().renderVersion);
    });
  });

  test("registers the resumable re-render queue and its periodic sweep", async () => {
    await withDb(async (database) => {
      const calls: string[] = [];
      let handler: (() => Promise<void>) | null = null;

      const boss = {
        getQueue: async () => null,
        createQueue: async (name: string) => {
          calls.push(`create:${name}`);
        },
        updateQueue: async (name: string) => {
          calls.push(`update:${name}`);
        },
        work: async (name: string, work: () => Promise<void>) => {
          calls.push(`work:${name}`);
          handler = work;
        },
        schedule: async (name: string, cron: string) => {
          calls.push(`schedule:${name}:${cron}`);
        },
        offWork: async (name: string) => {
          calls.push(`off:${name}`);
        },
      } as unknown as PgBoss;

      const jobs = await createContentJobs({ boss, sql: database.sql });

      expect(calls).toContain(`work:${CONTENT_RERENDER_QUEUE}`);
      expect(calls).toContain(`schedule:${CONTENT_RERENDER_QUEUE}:${CONTENT_RERENDER_CRON}`);

      const author = await createMember(database);
      await insertQuoteSnapshot(
        database.sql,
        draft(author, { renderVersion: 1, sanitiserVersion: 2 }),
      );

      if (handler === null) {
        throw new Error("content re-render handler was not registered");
      }

      await handler();

      expect(
        (
          (await database.sql`
            SELECT count(*)::int AS count
            FROM core.quote_snapshots
            WHERE sanitiser_version <> ${SANITISER_VERSION}
          `) as Array<{ count: number }>
        )[0]?.count,
      ).toBe(0);

      await jobs.stop();
      expect(calls).toContain(`off:${CONTENT_RERENDER_QUEUE}`);
    });
  });
});
