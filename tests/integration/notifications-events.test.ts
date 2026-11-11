import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { emit, loadEvent, type StoredEvent } from "@bulletin/domain/events";
import { bumpPermVersion, can, forumActionMask, loadForumTree } from "@bulletin/domain/permissions";
import { reply, startTopic } from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { createNotificationsEventHandler } from "../../apps/workers/src/notifications.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(
  prefix: string,
  run: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
      ]),
    });
    await run(database);
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

async function forumId(database: TestDatabase, slug: string): Promise<string> {
  const [row] = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE slug = ${slug}
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Missing forum ${slug}`);
  }

  return row.id;
}

async function expectOk<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): Promise<T> {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
}

async function latestEvent(
  database: TestDatabase,
  type: StoredEvent["type"],
): Promise<StoredEvent> {
  const [row] = (await database.sql`
    SELECT id FROM core.events WHERE type = ${type} ORDER BY id DESC LIMIT 1
  `) as Array<{ id: bigint | string }>;

  if (row === undefined) {
    throw new Error(`No ${type} event`);
  }

  const event = await loadEvent(database.sql, BigInt(row.id));

  if (event === null) {
    throw new Error(`Could not load ${type} event`);
  }

  return event;
}

interface NotificationRow {
  readonly member_id: string;
  readonly type: string;
  readonly actor_id: string | null;
  readonly topic_id: string | null;
  readonly forum_id: string | null;
  readonly post_id: string | null;
  readonly count: number;
  readonly read_at: Date | string | null;
}

async function notifications(database: TestDatabase): Promise<readonly NotificationRow[]> {
  return (await database.sql`
    SELECT
      member_id::text AS member_id,
      type,
      actor_id::text AS actor_id,
      topic_id::text AS topic_id,
      forum_id::text AS forum_id,
      post_id::text AS post_id,
      count,
      read_at
    FROM core.notifications
    ORDER BY id
  `) as NotificationRow[];
}

async function startAndReply(
  database: TestDatabase,
  input: {
    readonly forum: string;
    readonly starter: string;
    readonly replier: string;
  },
): Promise<{ readonly topicId: string; readonly postId: string }> {
  const topic = await expectOk(
    await startTopic(database.sql, {
      actorId: input.starter,
      forumId: input.forum,
      title: "Notifications test topic",
      bodyMd: "The first post in this topic.",
    }),
  );
  const post = await expectOk(
    await reply(database.sql, {
      actorId: input.replier,
      topicId: topic.topicId,
      bodyMd: "A reply that should notify the starter.",
    }),
  );

  return { topicId: topic.topicId, postId: post.postId };
}

integrationDescribe("notifications subscriber", () => {
  test("a reply notifies the topic starter once, with IDs only", async () => {
    await withSeededDb("notifications_reply", async (database) => {
      const general = await forumId(database, "off-topic");
      const starter = await memberId(database, "member-1");
      const replier = await memberId(database, "member-2");
      const topic = await startAndReply(database, { forum: general, starter, replier });
      const event = await latestEvent(database, "post.created");

      expect(Object.keys(event.payloadIds).sort()).toEqual([
        "authorId",
        "forumId",
        "postId",
        "topicId",
      ]);
      expect(event.payloadIds).toMatchObject({
        postId: topic.postId,
        topicId: topic.topicId,
        forumId: general,
        authorId: replier,
      });

      const handler = createNotificationsEventHandler({ sql: database.sql });
      await handler(event);
      // At-least-once delivery: a retried job must not duplicate the notification.
      await handler(event);

      expect(await notifications(database)).toEqual([
        {
          member_id: starter,
          type: "topic.reply",
          actor_id: replier,
          topic_id: topic.topicId,
          forum_id: general,
          post_id: topic.postId,
          count: 1,
          read_at: null,
        },
      ]);
    });
  }, 30_000);

  test("does not notify a member about their own reply", async () => {
    await withSeededDb("notifications_self", async (database) => {
      const general = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const topic = await startAndReply(database, {
        forum: general,
        starter: author,
        replier: author,
      });

      const handler = createNotificationsEventHandler({ sql: database.sql });
      await handler(await latestEvent(database, "post.created"));

      expect(await notifications(database)).toEqual([]);
      expect(topic.topicId.length).toBeGreaterThan(0);
    });
  }, 30_000);

  test("drops the notification when the recipient loses access before delivery", async () => {
    await withSeededDb("notifications_lost", async (database) => {
      const staffRoom = await forumId(database, "staff-room");
      const starter = await memberId(database, "super-mod");
      const replier = await memberId(database, "admin");
      const topic = await startAndReply(database, {
        forum: staffRoom,
        starter,
        replier,
      });
      const event = await latestEvent(database, "post.created");

      const tree = await loadForumTree(database.sql);
      expect(await can(database.sql, starter, "read", { forumId: staffRoom, tree })).toBe(true);

      // Access is revoked after the reply event was recorded but before delivery.
      await database.sql`
        UPDATE core.forum_permissions fp
        SET actions = ${forumActionMask(["show"])}
        FROM core.forums f, core.masks m
        WHERE fp.forum_id = f.id
          AND fp.mask_id = m.id
          AND f.slug = 'staff-area'
          AND m.key = 'staff'
      `;
      await bumpPermVersion(database.sql);
      expect(await can(database.sql, starter, "read", { forumId: staffRoom, tree })).toBe(false);

      await createNotificationsEventHandler({ sql: database.sql })(event);

      expect(await notifications(database)).toEqual([]);
      expect(topic.postId.length).toBeGreaterThan(0);
    });
  }, 30_000);

  test("a promotion notifies the promoted member", async () => {
    await withSeededDb("notifications_promotion", async (database) => {
      const member = await memberId(database, "member-1");

      await database.sql.begin(async (tx) => {
        await emit(tx, {
          type: "member.promoted",
          aggregateId: BigInt(member),
          aggregateVersion: 1n,
          payloadIds: {
            memberId: BigInt(member),
            fromGroupId: 1n,
            toGroupId: 2n,
            ruleId: 3n,
          },
        });
      });

      const event = await latestEvent(database, "member.promoted");
      expect(event.payloadIds).toEqual({
        memberId: member,
        fromGroupId: "1",
        toGroupId: "2",
        ruleId: "3",
      });

      await createNotificationsEventHandler({ sql: database.sql })(event);

      expect(await notifications(database)).toEqual([
        {
          member_id: member,
          type: "member.promoted",
          actor_id: null,
          topic_id: null,
          forum_id: null,
          post_id: null,
          count: 1,
          read_at: null,
        },
      ]);
    });
  }, 30_000);

  test("granted roles can read, write and mark notifications read", async () => {
    await withSeededDb("notifications_grants", async ({ sql }) => {
      const [privileges] = (await sql`
        SELECT
          has_table_privilege('workers', 'core.notifications', 'INSERT') AS workers_insert,
          has_table_privilege('workers', 'core.notifications', 'SELECT') AS workers_select,
          has_table_privilege('user_app', 'core.notifications', 'SELECT') AS app_select,
          has_table_privilege('user_app', 'core.notifications', 'INSERT') AS app_insert,
          has_table_privilege('user_api', 'core.notifications', 'UPDATE') AS api_update,
          has_table_privilege('user_api', 'core.notifications', 'INSERT') AS api_insert
      `) as Array<Record<string, boolean>>;

      expect(privileges).toEqual({
        workers_insert: true,
        workers_select: true,
        app_select: true,
        app_insert: false,
        api_update: true,
        api_insert: false,
      });
    });
  }, 30_000);
});
