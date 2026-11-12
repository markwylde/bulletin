import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  conversationSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import {
  listConversations,
  readConversationForParticipant,
  searchConversations,
} from "@bulletin/domain/conversations";
import type { StorageClient } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

function storageStub(): {
  readonly storage: StorageClient;
  readonly keys: string[];
} {
  const keys: string[] = [];

  return {
    keys,
    storage: {
      async put(key: string) {
        keys.push(key);
        return 0;
      },
      async get() {
        return new Uint8Array();
      },
      async exists() {
        return true;
      },
      async stat() {
        return { size: 0, contentType: "text/plain", etag: "" };
      },
      async delete() {},
      async copy() {},
      async list() {
        return [];
      },
      presignGet() {
        return "";
      },
      presignPut() {
        return "";
      },
    },
  };
}

async function withSeededDb(
  run: (database: TestDatabase, keys: readonly string[]) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "conversation_seed" }, async (database) => {
    const recording = storageStub();

    await runSeeds({
      sql: database.sql,
      storage: recording.storage,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
        conversationSeedModule,
      ]),
    });
    await run(database, recording.keys);
  });
}

async function memberId(database: TestDatabase, sub: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing member ${sub}`);
  }

  return row.member_id;
}

integrationDescribe("conversation seed", () => {
  test("seeds 1:1, group, archived and left-participant conversations with an attachment", async () => {
    await withSeededDb(async (database, keys) => {
      const memberOne = await memberId(database, "member-1");
      const memberTwo = await memberId(database, "member-2");

      const rows = (await database.sql`
        SELECT id::text AS id, title
        FROM core.conversations
        ORDER BY id
      `) as Array<{ id: string; title: string }>;
      const byTitle = new Map(rows.map((row) => [row.title, row.id]));

      expect([...byTitle.keys()].sort()).toEqual([
        "A member left",
        "Old chat",
        "Photo walk",
        "Weekend plans",
      ]);

      expect(
        (
          await database.sql`
          SELECT count(*)::int AS count FROM core.conversation_participants
          WHERE conversation_id = ${byTitle.get("Weekend plans")}
        `
        )[0],
      ).toMatchObject({ count: 2 });
      expect(
        (
          await database.sql`
          SELECT count(*)::int AS count FROM core.conversation_participants
          WHERE conversation_id = ${byTitle.get("Photo walk")}
        `
        )[0],
      ).toMatchObject({ count: 3 });

      const archived = (await database.sql`
        SELECT folder FROM core.conversation_participants
        WHERE conversation_id = ${byTitle.get("Old chat")} AND member_id = ${memberOne}
      `) as Array<{ folder: string }>;
      expect(archived[0]?.folder).toBe("archive");

      const left = (await database.sql`
        SELECT state, left_at, block_reinvite
        FROM core.conversation_participants
        WHERE conversation_id = ${byTitle.get("A member left")} AND member_id = ${memberTwo}
      `) as Array<{ state: string; left_at: Date | null; block_reinvite: boolean }>;
      expect(left[0]?.state).toBe("left");
      expect(left[0]?.left_at).not.toBeNull();
      expect(left[0]?.block_reinvite).toBe(true);

      expect(
        (
          await database.sql`
          SELECT count(*)::int AS count
          FROM core.conversation_message_attachments cma
          JOIN core.conversation_messages m ON m.id = cma.message_id
          WHERE m.conversation_id = ${byTitle.get("Weekend plans")}
        `
        )[0],
      ).toMatchObject({ count: 1 });
      expect(keys.length).toBeGreaterThan(0);

      const lists = await listConversations(database.sql, memberOne);
      expect(lists.archive.map((row) => row.id)).toEqual([byTitle.get("Old chat")]);
      expect(lists.inbox.map((row) => row.id)).toEqual(
        expect.arrayContaining([
          byTitle.get("Weekend plans"),
          byTitle.get("Photo walk"),
          byTitle.get("A member left"),
        ]),
      );
      expect(lists.inbox.find((row) => row.id === byTitle.get("Weekend plans"))?.unreadCount).toBe(
        1,
      );

      // A member who left is not a participant on read.
      expect(
        await readConversationForParticipant(
          database.sql,
          byTitle.get("A member left") ?? "",
          memberTwo,
        ),
      ).toBeNull();

      // The seeded body is searchable in the member's own conversations.
      expect(
        (await searchConversations(database.sql, memberOne, "booked the table")).map(
          (row) => row.id,
        ),
      ).toContain(byTitle.get("Weekend plans"));
    });
  }, 30_000);

  test("the seed is idempotent", async () => {
    await withSeededDb(async (database) => {
      const [before] = (await database.sql`
        SELECT count(*)::int AS count FROM core.conversations
      `) as Array<{ count: number }>;

      await runSeeds({
        sql: database.sql,
        registry: new SeedRegistry([
          baseSeedModule,
          flagsSeedModule,
          permissionFixtureSeedModule,
          groupsSeedModule,
          membersSeedModule,
          conversationSeedModule,
        ]),
      });

      const [after] = (await database.sql`
        SELECT count(*)::int AS count FROM core.conversations
      `) as Array<{ count: number }>;

      expect(after?.count).toBe(before?.count);
    });
  }, 30_000);
});
