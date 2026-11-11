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
import { follow, unfollow } from "@bulletin/domain/follows";
import { bumpPermVersion, can, forumActionMask, loadForumTree } from "@bulletin/domain/permissions";
import { reply, startTopic } from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import {
  createNotificationsEventHandler,
  eligibleRecipients,
  processNotificationRecipients,
} from "../../apps/workers/src/notifications.ts";

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

  test("a mention notifies the mentioned member once with the mention type", async () => {
    await withSeededDb("notifications_mention", async (database) => {
      const forum = await forumId(database, "off-topic");
      const mentioned = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: mentioned,
          forumId: forum,
          title: "Mention topic",
          bodyMd: "Body.",
        }),
      );
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: `Thanks @[Regular Member Two](member:${mentioned})!`,
        }),
      );

      const [post] = (await database.sql`
        SELECT mentioned_member_ids::text AS mentioned FROM core.posts ORDER BY id DESC LIMIT 1
      `) as Array<{ mentioned: string }>;
      expect(post?.mentioned).toContain(mentioned);

      await createNotificationsEventHandler({ sql: database.sql })(
        await latestEvent(database, "post.created"),
      );

      expect(await notifications(database)).toEqual([
        {
          member_id: mentioned,
          type: "post.mention",
          actor_id: author,
          topic_id: topic.topicId,
          forum_id: forum,
          post_id: expect.any(String),
          count: 1,
          read_at: null,
        },
      ]);
    });
  }, 30_000);

  test("a quote notifies the quoted post's author", async () => {
    await withSeededDb("notifications_quote", async (database) => {
      const forum = await forumId(database, "off-topic");
      const quoted = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: quoted,
          forumId: forum,
          title: "Quote topic",
          bodyMd: "Original body.",
        }),
      );
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: `:::quote{source="post:${topic.postId}"}\nquoted\n:::`,
        }),
      );

      await createNotificationsEventHandler({ sql: database.sql })(
        await latestEvent(database, "post.created"),
      );

      const rows = await notifications(database);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            member_id: quoted,
            type: "post.quote",
            actor_id: author,
            topic_id: topic.topicId,
          }),
        ]),
      );
    });
  }, 30_000);

  test("followers of a topic, forum and member receive their notifications", async () => {
    await withSeededDb("notifications_followers", async (database) => {
      const forum = await forumId(database, "off-topic");
      const follower = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const other = await memberId(database, "member-fr");

      // Forum follow: a new topic notifies the forum follower.
      await follow(database.sql, { memberId: follower, kind: "forum", id: forum });
      await expectOk(
        await startTopic(database.sql, {
          actorId: other,
          forumId: forum,
          title: "Forum follower topic",
          bodyMd: "Body.",
        }),
      );
      const handler = createNotificationsEventHandler({ sql: database.sql });
      await handler(await latestEvent(database, "topic.created"));

      const topicCreated = (await notifications(database)).find(
        (row) => row.member_id === follower && row.type === "topic.created",
      );
      expect(topicCreated).toBeDefined();

      // Topic follow: a reply notifies the topic follower.
      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: other,
          forumId: forum,
          title: "Topic follower topic",
          bodyMd: "Body.",
        }),
      );
      await follow(database.sql, { memberId: follower, kind: "topic", id: topic.topicId });
      await expectOk(
        await reply(database.sql, { actorId: author, topicId: topic.topicId, bodyMd: "Reply." }),
      );
      await handler(await latestEvent(database, "post.created"));

      expect(
        (await notifications(database)).some(
          (row) =>
            row.member_id === follower &&
            row.type === "topic.reply" &&
            row.topic_id === topic.topicId,
        ),
      ).toBe(true);

      // Member follow: a post by the followed member notifies the follower.
      await follow(database.sql, { memberId: follower, kind: "member", id: author });
      const second = await expectOk(
        await startTopic(database.sql, {
          actorId: other,
          forumId: forum,
          title: "Member follower topic",
          bodyMd: "Body.",
        }),
      );
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: second.topicId,
          bodyMd: "Followed member reply.",
        }),
      );
      await handler(await latestEvent(database, "post.created"));

      expect(
        (await notifications(database)).some(
          (row) =>
            row.member_id === follower &&
            row.type === "topic.reply" &&
            row.topic_id === second.topicId,
        ),
      ).toBe(true);
    });
  }, 30_000);

  test("replies coalesce into one unread entry until it is read", async () => {
    await withSeededDb("notifications_coalesce", async (database) => {
      const forum = await forumId(database, "off-topic");
      const starter = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: starter,
          forumId: forum,
          title: "Coalescing topic",
          bodyMd: "Body.",
        }),
      );
      const handler = createNotificationsEventHandler({ sql: database.sql });

      for (let index = 0; index < 5; index += 1) {
        await expectOk(
          await reply(database.sql, {
            actorId: author,
            topicId: topic.topicId,
            bodyMd: `Reply ${index + 1}.`,
          }),
        );
        await handler(await latestEvent(database, "post.created"));
      }

      expect(await notifications(database)).toEqual([
        expect.objectContaining({ member_id: starter, type: "topic.reply", count: 5 }),
      ]);

      await database.sql`UPDATE core.notifications SET read_at = now() WHERE member_id = ${starter}`;
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: "Reply after reading.",
        }),
      );
      await handler(await latestEvent(database, "post.created"));

      const rows = await notifications(database);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.count).sort()).toEqual([1, 5]);
    });
  }, 30_000);

  test("recipient filters can drop a member before delivery", async () => {
    await withSeededDb("notifications_filter", async (database) => {
      const forum = await forumId(database, "off-topic");
      const starter = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: starter,
          forumId: forum,
          title: "Filtered topic",
          bodyMd: "Body.",
        }),
      );
      await expectOk(
        await reply(database.sql, { actorId: author, topicId: topic.topicId, bodyMd: "Reply." }),
      );

      const handler = createNotificationsEventHandler({
        sql: database.sql,
        filters: [async ({ recipient }) => recipient.memberId !== starter],
      });
      await handler(await latestEvent(database, "post.created"));

      expect(await notifications(database)).toEqual([]);
    });
  }, 30_000);

  test("a mention in content the recipient cannot read delivers nothing", async () => {
    await withSeededDb("notifications_mention_lost", async (database) => {
      const staffRoom = await forumId(database, "staff-room");
      const outsider = await memberId(database, "member-1");
      const starter = await memberId(database, "super-mod");
      const author = await memberId(database, "admin");
      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: starter,
          forumId: staffRoom,
          title: "Staff mention",
          bodyMd: "Body.",
        }),
      );
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: `Secret @[Regular Member One](member:${outsider})`,
        }),
      );

      await createNotificationsEventHandler({ sql: database.sql })(
        await latestEvent(database, "post.created"),
      );

      expect((await notifications(database)).filter((row) => row.member_id === outsider)).toEqual(
        [],
      );
    });
  }, 30_000);

  test("a soft-deleted post and a held topic produce no notifications", async () => {
    await withSeededDb("notifications_visibility", async (database) => {
      const forum = await forumId(database, "off-topic");
      const starter = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: starter,
          forumId: forum,
          title: "Visibility topic",
          bodyMd: "Body.",
        }),
      );
      const post = await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: "Soon deleted.",
        }),
      );
      await database.sql`UPDATE core.posts SET visibility = 'soft_deleted' WHERE id = ${post.postId}`;
      await createNotificationsEventHandler({ sql: database.sql })(
        await latestEvent(database, "post.created"),
      );
      expect(await notifications(database)).toEqual([]);

      // The first post of a held topic is unapproved: no topic.created notification either.
      const held = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Held topic",
          bodyMd: "Awaiting approval.",
        }),
      );
      await database.sql`
        UPDATE core.posts SET visibility = 'unapproved' WHERE id = ${held.postId}
      `;
      await createNotificationsEventHandler({ sql: database.sql })(
        await latestEvent(database, "topic.created"),
      );
      expect(await notifications(database)).toEqual([]);
    });
  }, 30_000);

  test("a starter who disabled auto-follow or unfollowed gets no reply notifications", async () => {
    await withSeededDb("notifications_starter_follows", async (database) => {
      const forum = await forumId(database, "off-topic");
      const starter = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");

      const detached = await expectOk(
        await startTopic(database.sql, {
          actorId: starter,
          forumId: forum,
          title: "No auto-follow topic",
          bodyMd: "Body.",
          autoFollow: false,
        }),
      );
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: detached.topicId,
          bodyMd: "A reply.",
        }),
      );
      await createNotificationsEventHandler({ sql: database.sql })(
        await latestEvent(database, "post.created"),
      );
      expect(await notifications(database)).toEqual([]);

      const unfollowed = await expectOk(
        await startTopic(database.sql, {
          actorId: starter,
          forumId: forum,
          title: "Unfollowed topic",
          bodyMd: "Body.",
        }),
      );
      await unfollow(database.sql, {
        memberId: starter,
        kind: "topic",
        id: unfollowed.topicId,
      });
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: unfollowed.topicId,
          bodyMd: "Another reply.",
        }),
      );
      await createNotificationsEventHandler({ sql: database.sql })(
        await latestEvent(database, "post.created"),
      );
      expect(await notifications(database)).toEqual([]);
    });
  }, 30_000);

  test("large recipient sets fan out in bounded chunks", async () => {
    await withSeededDb("notifications_fanout", async (database) => {
      const forum = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const starter = await memberId(database, "member-2");
      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: starter,
          forumId: forum,
          title: "Fan-out topic",
          bodyMd: "Body.",
        }),
      );
      await database.sql`
        INSERT INTO core.members (display_name, name_skeleton)
        SELECT 'Bulk Member ' || lpad(value::text, 3, '0'),
               'bulk member ' || lpad(value::text, 3, '0')
        FROM generate_series(1, 505) AS value
        ON CONFLICT DO NOTHING
      `;
      await database.sql`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        SELECT m.id, g.id, true
        FROM core.members m, core.groups g
        WHERE m.display_name LIKE 'Bulk Member %' AND g.key = 'members'
        ON CONFLICT DO NOTHING
      `;
      await database.sql`
        INSERT INTO core.followed_topics (member_id, topic_id)
        SELECT m.id, ${topic.topicId}
        FROM core.members m
        WHERE m.display_name LIKE 'Bulk Member %'
        ON CONFLICT DO NOTHING
      `;
      const [followCount] = (await database.sql`
        SELECT count(*)::int AS count FROM core.followed_topics WHERE topic_id = ${topic.topicId}
      `) as Array<{ count: number }>;
      expect(followCount?.count).toBeGreaterThan(500);
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: "Fan-out reply.",
        }),
      );
      const event = await latestEvent(database, "post.created");
      const jobs: Array<{ eventId: string; chunk: number }> = [];
      const options = {
        sql: database.sql,
        async enqueueFanout(job: { eventId: string; chunk: number }) {
          jobs.push(job);
        },
      };

      await createNotificationsEventHandler(options)(event);
      expect(jobs).toHaveLength(2);

      const eligible = await eligibleRecipients(options, event);
      expect(eligible.length).toBeGreaterThan(500);

      for (const job of jobs) {
        await processNotificationRecipients(
          options,
          event,
          eligible.slice(job.chunk * 500, (job.chunk + 1) * 500),
        );
      }

      const [count] = (await database.sql`
        SELECT count(*)::int AS count FROM core.notifications
        WHERE type = 'topic.reply' AND topic_id = ${topic.topicId}
      `) as Array<{ count: number }>;
      expect(count?.count).toBe(eligible.length);
    });
  }, 120_000);

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
