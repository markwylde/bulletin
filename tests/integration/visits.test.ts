import { describe, expect, test } from "bun:test";
import {
  createRenderCache,
  createTagVersions,
  readTagVersions,
  topicPagesTag,
} from "@bulletin/cache";
import {
  consumeRateBucket,
  PRESENCE_REFRESH_MS,
  recordVisit,
  VIEW_DEDUPE_MS,
} from "@bulletin/domain/visits";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "visits" }, run);
}

async function createMember(database: TestDatabase, name: string): Promise<string> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, name_skeleton)
    VALUES (${name}, ${name.toLowerCase()})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (member === undefined) {
    throw new Error("Could not create a member");
  }

  return member.id;
}

integrationDescribe("read-path visits", () => {
  test("a member visit records a deduped view, presence and the read marker", async () => {
    await withDb(async (database) => {
      const memberId = await createMember(database, "Visit member");
      const viewerKey = `member:${memberId}`;
      const now = new Date("2026-11-10T12:00:00Z");

      expect(
        await recordVisit(database.sql, { viewerKey, ctx: "topic:201", memberId, now }),
      ).toEqual({ unread: [] });
      // The same viewer in the same half-hour bucket is one view (ADR 0006 dedupe).
      await recordVisit(database.sql, {
        viewerKey,
        ctx: "topic:201",
        memberId,
        now: new Date(now.getTime() + 60_000),
      });

      const views = (await database.sql`
        SELECT count(*)::int AS count FROM core.topic_view_buffer WHERE topic_id = 201
      `) as Array<{ count: number }>;
      const reads = (await database.sql`
        SELECT topic_id::text AS topic_id FROM core.topic_reads WHERE member_id = ${memberId}
      `) as Array<{ topic_id: string }>;
      const presence = (await database.sql`
        SELECT location FROM core.presence WHERE viewer_key = ${viewerKey}
      `) as Array<{ location: string }>;

      expect(views[0]?.count).toBe(1);
      expect(reads).toEqual([{ topic_id: "201" }]);
      expect(presence).toEqual([{ location: "topic:201" }]);
    });
  });

  test("a list-page visit returns the unread topics and leaves the read ones out", async () => {
    await withDb(async (database) => {
      const memberId = await createMember(database, "List member");

      await recordVisit(database.sql, {
        viewerKey: `member:${memberId}`,
        ctx: "topic:201",
        memberId,
      });

      const result = await recordVisit(database.sql, {
        viewerKey: `member:${memberId}`,
        ctx: "forum:2",
        topics: ["201", "202", "203"],
        memberId,
      });

      expect(result.unread).toEqual(["202", "203"]);
    });
  });

  test("presence is refreshed at most once a minute", async () => {
    await withDb(async (database) => {
      const viewerKey = "guest:11111111-2222-3333-4444-555555555555";
      const first = new Date("2026-11-10T12:00:00Z");

      await recordVisit(database.sql, { viewerKey, ctx: "forum:2", now: first });
      await recordVisit(database.sql, {
        viewerKey,
        ctx: "forum:3",
        now: new Date(first.getTime() + PRESENCE_REFRESH_MS / 2),
      });

      const [early] = (await database.sql`
        SELECT location, last_seen FROM core.presence WHERE viewer_key = ${viewerKey}
      `) as Array<{ location: string; last_seen: Date }>;
      expect(early?.location).toBe("forum:2");

      await recordVisit(database.sql, {
        viewerKey,
        ctx: "forum:3",
        now: new Date(first.getTime() + PRESENCE_REFRESH_MS + 1_000),
      });

      const [late] = (await database.sql`
        SELECT location FROM core.presence WHERE viewer_key = ${viewerKey}
      `) as Array<{ location: string }>;
      expect(late?.location).toBe("forum:3");
    });
  });

  test("guests record a view and presence but never a read marker", async () => {
    await withDb(async (database) => {
      const guest = "guest:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

      await recordVisit(database.sql, { viewerKey: guest, ctx: "topic:202" });

      const views = (await database.sql`
        SELECT count(*)::int AS count FROM core.topic_view_buffer WHERE topic_id = 202
      `) as Array<{ count: number }>;
      const reads = (await database.sql`
        SELECT count(*)::int AS count FROM core.topic_reads
      `) as Array<{ count: number }>;

      expect(views[0]?.count).toBe(1);
      expect(reads[0]?.count).toBe(0);
    });
  });

  test("rate buckets count per window and reject over the limit", async () => {
    await withDb(async (database) => {
      const now = new Date("2026-11-10T12:00:00Z");
      const options = { key: "beacon:203.0.113.9", limit: 2, windowMs: 60_000, now };

      expect(await consumeRateBucket(database.sql, options)).toBe(true);
      expect(await consumeRateBucket(database.sql, options)).toBe(true);
      expect(await consumeRateBucket(database.sql, options)).toBe(false);

      expect(
        await consumeRateBucket(database.sql, {
          ...options,
          now: new Date(now.getTime() + 61_000),
        }),
      ).toBe(true);
    });
  });

  test("visits never bump a content tag and the cached fragment keeps hitting", async () => {
    await withDb(async (database) => {
      const memberId = await createMember(database, "Cache member");
      const versions = await createTagVersions({
        sql: database.sql,
        heartbeatMs: 100,
        heartbeatTimeoutMs: 1_000,
      });

      try {
        const cache = createRenderCache({ tags: versions });
        const render = () => "<article>topic 201</article>";
        const request = { key: "topic-page", tags: [topicPagesTag("201")], render };

        await cache.getOrRender(request);

        const before = await readTagVersions(database.sql, [topicPagesTag("201")]);

        for (let index = 0; index < 100; index += 1) {
          await recordVisit(database.sql, {
            viewerKey: `member:${memberId}:${index}`,
            ctx: "topic:201",
            memberId,
            now: new Date(Date.now() + index * 1_000),
          });
        }

        const after = await readTagVersions(database.sql, [topicPagesTag("201")]);

        expect(after).toEqual(before);
        expect((await cache.getOrRender(request)).status).toBe("hit");
      } finally {
        await versions.close();
      }
    });
  });

  test("the dedupe window is half an hour", () => {
    expect(VIEW_DEDUPE_MS).toBe(30 * 60 * 1_000);
  });
});
