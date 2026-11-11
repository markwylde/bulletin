import { describe, expect, test } from "bun:test";
import { type DomainEvent, EVENT_CATALOG, type EventType, emit } from "@bulletin/domain/events";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(
  prefix: string,
  run: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix }, run);
}

const FORBIDDEN_PAYLOAD_KEYS = [
  "body",
  "bodyHtml",
  "bodyMd",
  "bodyText",
  "content",
  "email",
  "text",
];

function eventFor(type: EventType): DomainEvent<EventType> {
  const payload = Object.fromEntries(
    EVENT_CATALOG[type].payloadIds.map((key, index) => [key, BigInt(index + 1)]),
  );

  return {
    type,
    aggregateId: 42n,
    aggregateVersion: 1n,
    payloadIds: payload,
  } as unknown as DomainEvent<EventType>;
}

integrationDescribe("domain event catalog", () => {
  test("every type declares an aggregate and an ID-only payload", () => {
    const types = Object.keys(EVENT_CATALOG) as EventType[];

    expect(types).toEqual(
      expect.arrayContaining([
        "topic.created",
        "post.created",
        "post.edited",
        "member.created",
        "member.promoted",
        "notification.created",
        "follow.created",
        "follow.removed",
        "digest.sent",
      ]),
    );

    for (const type of types) {
      const entry = EVENT_CATALOG[type];
      expect(entry.aggregateType.length).toBeGreaterThan(0);
      expect(entry.payloadIds.length).toBeGreaterThan(0);
      expect(new Set(entry.payloadIds).size).toBe(entry.payloadIds.length);

      for (const key of entry.payloadIds) {
        expect(key).toMatch(/Id$/);
        expect(FORBIDDEN_PAYLOAD_KEYS).not.toContain(key);
      }
    }
  });

  test("emit stores every catalog type as ID strings", async () => {
    await withDb("event_catalog_emit", async (database) => {
      const types = Object.keys(EVENT_CATALOG) as EventType[];

      for (const type of types) {
        await emit(database.sql, eventFor(type));
      }

      const rows = (await database.sql`
        SELECT type, payload_ids
        FROM core.events
        ORDER BY id
      `) as Array<{ type: EventType; payload_ids: unknown }>;

      expect(rows.map((row) => row.type)).toEqual(types);

      for (const row of rows) {
        const payload =
          typeof row.payload_ids === "string"
            ? (JSON.parse(row.payload_ids) as Record<string, string>)
            : (row.payload_ids as Record<string, string>);

        expect(Object.keys(payload).sort()).toEqual([...EVENT_CATALOG[row.type].payloadIds].sort());

        for (const value of Object.values(payload)) {
          expect(value).toMatch(/^\d+$/);
        }
      }
    });
  });

  test("emit rejects payloads with missing or extra IDs", async () => {
    await withDb("event_catalog_payload", async ({ sql }) => {
      const missing = {
        type: "post.created",
        aggregateId: 10n,
        aggregateVersion: 1n,
        payloadIds: { postId: 1n, topicId: 2n, forumId: 3n },
      } as unknown as DomainEvent<EventType>;

      const extra = {
        type: "post.created",
        aggregateId: 10n,
        aggregateVersion: 1n,
        payloadIds: { postId: 1n, topicId: 2n, forumId: 3n, authorId: 4n, body: 5n },
      } as unknown as DomainEvent<EventType>;

      await expect(emit(sql, missing)).rejects.toThrow(/exactly/);
      await expect(emit(sql, extra)).rejects.toThrow(/exactly/);

      const [{ count }] = (await sql`
        SELECT count(*)::int AS count FROM core.events
      `) as Array<{ count: number }>;
      expect(count).toBe(0);
    });
  });
});
