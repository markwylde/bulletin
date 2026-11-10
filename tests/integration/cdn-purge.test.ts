import { describe, expect, test } from "bun:test";
import type { CdnPurger } from "@bulletin/cache";
import { loadEvent } from "@bulletin/db/events";
import {
  baseSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { forumSubtreeTags } from "@bulletin/domain/permissions";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { saveMatrixCell } from "../../apps/staff-api/src/masks.ts";
import { createCoreEventHandler } from "../../apps/workers/src/core-events.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "cdn_purge" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
      ]),
    });
    await run(database);
  });
}

interface Recorder {
  readonly purger: CdnPurger;
  readonly calls: string[][];
}

function recordingPurger(ok = true): Recorder {
  const calls: string[][] = [];

  return {
    calls,
    purger: {
      async purge(tags) {
        calls.push([...tags]);
        return { tags, ok };
      },
    },
  };
}

async function standardMask(database: TestDatabase): Promise<string> {
  const [mask] = (await database.sql`
    SELECT id::text AS id FROM core.masks WHERE key = 'standard'
  `) as Array<{ id: string }>;

  if (mask === undefined) {
    throw new Error("No standard mask");
  }

  return mask.id;
}

integrationDescribe("CDN purge on visibility change (ADR 0006)", () => {
  test("a matrix change emits a visibility event and its subtree tags are purged", async () => {
    await withDb(async (database) => {
      const maskId = await standardMask(database);
      const [actor] = (await database.sql`
        SELECT i.member_id::text AS id FROM pii.identities i WHERE i.sub = 'admin'
      `) as Array<{ id: string }>;

      if (actor === undefined) {
        throw new Error("No admin member");
      }

      // A parent forum so the purge must cover the subtree.
      const result = await saveMatrixCell(database.sql, actor.id, {
        forumId: "1",
        maskId,
        permissionAction: "read",
        allowed: false,
      });

      expect(result.ok).toBe(true);

      const events = (await database.sql`
        SELECT id, payload_ids FROM core.events
        WHERE type = 'forum.visibility.changed'
        ORDER BY id DESC
        LIMIT 1
      `) as Array<{ id: string; payload_ids: string | { forumId: string } }>;
      const event = events[0];
      const payloadIds =
        typeof event?.payload_ids === "string"
          ? (JSON.parse(event.payload_ids) as { forumId: string })
          : event?.payload_ids;

      expect(payloadIds?.forumId).toBe("1");

      expect((await forumSubtreeTags(database.sql, "1")).sort()).toEqual([
        "forum:1",
        "forum:2",
        "forum:3",
        "forum:4",
      ]);

      const recorder = recordingPurger();
      const handler = createCoreEventHandler({ sql: database.sql, purger: recorder.purger });
      const stored = event === undefined ? null : await loadEvent(database.sql, BigInt(event.id));

      if (stored === null) {
        throw new Error("Event not found");
      }

      await handler(stored);

      expect(recorder.calls).toEqual([["forum:1", "forum:2", "forum:3", "forum:4"]]);
    });
  });

  test("the worker handler throws so pg-boss retries after a failed purge", async () => {
    await withDb(async (database) => {
      const recorder = recordingPurger(false);
      const handler = createCoreEventHandler({ sql: database.sql, purger: recorder.purger });

      await expect(
        handler({
          id: 1n,
          type: "forum.visibility.changed",
          aggregateType: "forum",
          aggregateId: 2n,
          aggregateVersion: 1n,
          payloadIds: { forumId: "2" },
          createdAt: new Date(),
          publishedAt: null,
        }),
      ).rejects.toThrow("CDN purge failed for forum:2");
    });
  });

  test("unrelated events are ignored by the core handler", async () => {
    await withDb(async (database) => {
      const recorder = recordingPurger();
      const handler = createCoreEventHandler({ sql: database.sql, purger: recorder.purger });

      await handler({
        id: 1n,
        type: "member.promoted",
        aggregateType: "member",
        aggregateId: 2n,
        aggregateVersion: 1n,
        payloadIds: { memberId: "2" },
        createdAt: new Date(),
        publishedAt: null,
      });

      expect(recorder.calls).toEqual([]);
    });
  });
});
