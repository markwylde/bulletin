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
import { follow } from "@bulletin/domain/follows";
import {
  digestFrequency,
  digestItems,
  pendingDigestDeliveries,
  queueDigests,
  setDigestFrequency,
  setNotificationPreference,
} from "@bulletin/domain/notifications";
import { bumpPermVersion, forumActionMask } from "@bulletin/domain/permissions";
import { reply, startTopic } from "@bulletin/domain/topics";
import { createMailStore } from "@bulletin/mock-mail/message";
import { startSmtpServer } from "@bulletin/mock-mail/smtp";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { userOrigin } from "@bulletin/test-utils/urls";
import { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { notificationDigestResponse } from "../../apps/user-api/src/notifications.ts";
import { createDigestJobs, deliverDigestEmail } from "../../apps/workers/src/digest.ts";
import type { EmailOptions } from "../../apps/workers/src/email.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const SECRET = "digest-test-secret";

async function withMailStack(
  run: (context: {
    readonly database: TestDatabase;
    readonly worker: SQL;
    readonly store: ReturnType<typeof createMailStore>;
    readonly options: EmailOptions;
  }) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  const store = createMailStore();
  const server = startSmtpServer({ port: 0, store, hostname: "127.0.0.1" });

  try {
    await withTestDatabase({ adminUrl, prefix: "digest" }, async (database) => {
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

      const workerUrl = new URL(database.url);
      workerUrl.username = "workers";
      workerUrl.password = "";
      const worker = new SQL(workerUrl.toString());

      try {
        await run({
          database,
          worker,
          store,
          options: {
            smtpUrl: `smtp://127.0.0.1:${server.port}`,
            mailFrom: "Bulletin <no-reply@bulletin.test>",
            userOrigin: userOrigin(),
            unsubscribeSecret: SECRET,
          },
        });
      } finally {
        await worker.close();
      }
    });
  } finally {
    server.stop();
  }
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

function expectOk<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): T {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
}

integrationDescribe("digests", () => {
  test("a followed member's activity reaches the digest and stays permission-filtered", async () => {
    await withMailStack(async ({ database }) => {
      const member = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const publicForum = await forumId(database, "off-topic");
      const staffForum = await forumId(database, "staff-room");

      await setNotificationPreference(database.sql, member, "topic.reply", "digest", true);
      await follow(database.sql, { memberId: member, kind: "member", id: author });

      const since = new Date(Date.now() - 1_000);
      expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: publicForum,
          title: "Followed member public post",
          bodyMd: "Body.",
        }),
      );

      const [hiddenTopic] = (await database.sql`
        INSERT INTO core.topics (forum_id, title, slug, starter_id)
        VALUES (${staffForum}, 'Followed member hidden post', 'followed-member-hidden-post', ${author})
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (hiddenTopic === undefined) {
        throw new Error("Could not create the hidden topic");
      }

      const [hiddenPost] = (await database.sql`
        INSERT INTO core.posts (
          topic_id, author_id, body_md, body_html, body_text, render_version, sanitiser_version, position
        )
        VALUES (${hiddenTopic.id}, ${author}, 'Body.', '<p>Body.</p>', 'Body.', 1, 1, 1)
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      await database.sql`
        UPDATE core.topics
        SET first_post_id = ${hiddenPost?.id ?? null}, last_post_id = ${hiddenPost?.id ?? null}, last_post_at = now()
        WHERE id = ${hiddenTopic.id}
      `;

      const items = await digestItems(database.sql, member, {
        since,
        until: new Date(Date.now() + 1_000),
      });
      const titles = items.map((item) => item.title);

      expect(titles).toContain("Followed member public post");
      expect(titles).not.toContain("Followed member hidden post");
    });
  }, 60_000);

  test("a weekly digest lists followed activity the member can read", async () => {
    await withMailStack(async ({ database, worker, store, options }) => {
      const member = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");

      await setDigestFrequency(database.sql, member, "weekly");
      await setNotificationPreference(database.sql, member, "topic.created", "digest", true);
      await follow(database.sql, { memberId: member, kind: "forum", id: forum });

      const newTopic = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Digest new topic",
          bodyMd: "Body.",
        }),
      );

      const queued = await queueDigests(worker, "weekly");
      expect(queued).toHaveLength(1);
      expect(
        await deliverDigestEmail(
          worker,
          options,
          queued[0] ?? {
            intentId: "0",
            deliveryId: "0",
          },
        ),
      ).toBe("sent");

      const message = store.list()[0];
      expect(message?.subject).toBe("Your weekly digest");
      expect(message?.text).toContain("Digest new topic");
      expect(message?.text).toContain(`/topic/${newTopic.topicId}-digest-new-topic`);

      const [delivery] = (await database.sql`
        SELECT delivered_at FROM core.delivery_intents WHERE id = ${queued[0]?.intentId ?? "0"}
      `) as Array<{ delivered_at: Date | null }>;
      expect(delivery?.delivered_at).not.toBeNull();
      expect(await digestFrequency(database.sql, member)).toBe("weekly");
    });
  }, 60_000);

  test("a digest is delivered even when the notifications flag is off", async () => {
    await withMailStack(async ({ database, worker, store, options }) => {
      const member = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");

      await database.sql`
        INSERT INTO core.feature_flags (key, description, owner, default_value)
        VALUES ('notifications', 'In-app notifications.', 'core', false)
        ON CONFLICT (key) DO UPDATE SET default_value = false
      `;

      await setDigestFrequency(database.sql, member, "weekly");
      await setNotificationPreference(database.sql, member, "topic.created", "digest", true);
      await follow(database.sql, { memberId: member, kind: "forum", id: forum });
      expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Digest while notifications are off",
          bodyMd: "Body.",
        }),
      );

      const queued = await queueDigests(worker, "weekly");
      expect(queued).toHaveLength(1);
      expect(
        await deliverDigestEmail(worker, options, queued[0] ?? { intentId: "0", deliveryId: "0" }),
      ).toBe("sent");
      expect(store.list()[0]?.text).toContain("Digest while notifications are off");
    });
  }, 60_000);

  test("content that became unreadable after the window is not sent", async () => {
    await withMailStack(async ({ database, worker, store, options }) => {
      const member = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");

      await setDigestFrequency(database.sql, member, "weekly");
      await setNotificationPreference(database.sql, member, "topic.created", "digest", true);
      await follow(database.sql, { memberId: member, kind: "forum", id: forum });
      expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Will become hidden",
          bodyMd: "Body.",
        }),
      );

      // Revoke the members' read bit on Off Topic before the digest is built.
      await database.sql`
        INSERT INTO core.forum_permissions (forum_id, mask_id, actions, inherits)
        SELECT ${forum}, m.id, ${forumActionMask(["show"])}, false
        FROM core.masks m
        WHERE m.key = 'standard'
        ON CONFLICT (forum_id, mask_id) DO UPDATE
          SET actions = EXCLUDED.actions, inherits = EXCLUDED.inherits
      `;
      await bumpPermVersion(database.sql);

      const queued = await queueDigests(worker, "weekly");
      expect(queued).toHaveLength(1);
      expect(
        await deliverDigestEmail(
          worker,
          options,
          queued[0] ?? {
            intentId: "0",
            deliveryId: "0",
          },
        ),
      ).toBe("skipped");
      expect(store.list()).toEqual([]);
    });
  }, 60_000);

  test("digest content follows per-type digest preferences and includes mentions", async () => {
    await withMailStack(async ({ database, worker, store, options }) => {
      const member = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");

      await setDigestFrequency(database.sql, member, "weekly");
      await setNotificationPreference(database.sql, member, "topic.reply", "digest", true);
      await setNotificationPreference(database.sql, member, "post.mention", "digest", true);
      await setNotificationPreference(database.sql, member, "topic.created", "digest", false);
      await follow(database.sql, { memberId: member, kind: "forum", id: forum });

      const followed = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Digest followed topic",
          bodyMd: "Body.",
        }),
      );
      await follow(database.sql, { memberId: member, kind: "topic", id: followed.topicId });
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: followed.topicId,
          bodyMd: "A reply.",
        }),
      );
      expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Digest excluded topic",
          bodyMd: "Body.",
        }),
      );
      const mentionTopic = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Digest mention topic",
          bodyMd: "Body.",
        }),
      );
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: mentionTopic.topicId,
          bodyMd: `Hello @[Regular Member Two](member:${member})`,
        }),
      );

      const queued = await queueDigests(worker, "weekly");
      expect(queued).toHaveLength(1);
      expect(
        await deliverDigestEmail(worker, options, queued[0] ?? { intentId: "0", deliveryId: "0" }),
      ).toBe("sent");

      const text = store.list()[0]?.text ?? "";
      expect(text).toContain("Digest followed topic");
      expect(text).toContain("Digest mention topic");
      expect(text).not.toContain("Digest excluded topic");
    });
  }, 60_000);

  test("a delivery whose enqueue was lost is recovered with its original window", async () => {
    await withMailStack(async ({ database, worker, store, options }) => {
      const member = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");

      await setDigestFrequency(database.sql, member, "weekly");
      await setNotificationPreference(database.sql, member, "topic.created", "digest", true);
      await follow(database.sql, { memberId: member, kind: "forum", id: forum });
      expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Recovered digest topic",
          bodyMd: "Body.",
        }),
      );

      // The delivery and intent commit, then the process "crashes" before enqueueing.
      const queued = await queueDigests(worker, "weekly");
      expect(queued).toHaveLength(1);
      const pending = await pendingDigestDeliveries(worker);
      expect(pending).toEqual([
        expect.objectContaining({
          deliveryId: queued[0]?.deliveryId,
          intentId: queued[0]?.intentId,
        }),
      ]);

      // A second cron run must not start a new window while the first is still pending.
      expect(await queueDigests(worker, "weekly")).toEqual([]);

      expect(
        await deliverDigestEmail(worker, options, queued[0] ?? { intentId: "0", deliveryId: "0" }),
      ).toBe("sent");
      expect(store.list()[0]?.text).toContain("Recovered digest topic");

      const [delivery] = (await database.sql`
        SELECT period_end FROM core.digest_deliveries WHERE id = ${queued[0]?.deliveryId ?? "0"}
      `) as Array<{ period_end: Date }>;
      const [subscription] = (await database.sql`
        SELECT last_sent_at FROM core.digest_subscriptions WHERE member_id = ${member}
      `) as Array<{ last_sent_at: Date }>;
      expect(new Date(subscription?.last_sent_at ?? 0).toISOString()).toBe(
        new Date(delivery?.period_end ?? 0).toISOString(),
      );
      expect(await pendingDigestDeliveries(worker)).toEqual([]);
    });
  }, 60_000);

  test("soft-deleted replies and held topics stay out of the digest", async () => {
    await withMailStack(async ({ database, worker, store, options }) => {
      const member = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");

      await setDigestFrequency(database.sql, member, "weekly");
      await setNotificationPreference(database.sql, member, "topic.reply", "digest", true);
      await follow(database.sql, { memberId: member, kind: "forum", id: forum });

      const followed = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Deleted digest reply topic",
          bodyMd: "Body.",
        }),
      );
      await follow(database.sql, { memberId: member, kind: "topic", id: followed.topicId });
      // The topic's first post predates the digest window, so only the deleted reply could count.
      await database.sql`
        UPDATE core.posts SET created_at = now() - interval '10 days' WHERE id = ${followed.postId}
      `;
      const replyResult = await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: followed.topicId,
          bodyMd: "Deleted later.",
        }),
      );
      await database.sql`
        UPDATE core.posts SET visibility = 'soft_deleted' WHERE id = ${replyResult.postId}
      `;

      const held = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Held digest topic",
          bodyMd: "Awaiting approval.",
        }),
      );
      await database.sql`
        UPDATE core.posts SET visibility = 'unapproved' WHERE id = ${held.postId}
      `;

      const queued = await queueDigests(worker, "weekly");
      expect(queued).toHaveLength(1);
      expect(
        await deliverDigestEmail(worker, options, queued[0] ?? { intentId: "0", deliveryId: "0" }),
      ).toBe("skipped");
      expect(store.list()).toEqual([]);
    });
  }, 60_000);

  test("digest items cover every selectable type and honour each channel", async () => {
    await withMailStack(async ({ database, worker }) => {
      const member = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");

      await setDigestFrequency(database.sql, member, "weekly");
      const types = [
        "topic.reply",
        "topic.created",
        "post.mention",
        "post.quote",
        "member.promoted",
        "reaction.added",
      ] as const;

      for (const type of types) {
        await setNotificationPreference(database.sql, member, type, "digest", true);
      }

      await follow(database.sql, { memberId: member, kind: "forum", id: forum });

      const followed = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "All types reply",
          bodyMd: "Body.",
        }),
      );
      await follow(database.sql, { memberId: member, kind: "topic", id: followed.topicId });
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: followed.topicId,
          bodyMd: "Reply activity.",
        }),
      );

      expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "All types new topic",
          bodyMd: "Body.",
        }),
      );

      const mentioned = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "All types mention",
          bodyMd: "Body.",
        }),
      );
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: mentioned.topicId,
          bodyMd: `Hi @[Regular Member Two](member:${member})`,
        }),
      );

      const quotedTopic = await expectOk(
        await startTopic(database.sql, {
          actorId: member,
          forumId: forum,
          title: "All types quote",
          bodyMd: "My post to quote.",
        }),
      );
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: quotedTopic.topicId,
          bodyMd: `:::quote{source="post:${quotedTopic.postId}"}\nquoted\n:::`,
        }),
      );

      const reactionTopic = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: await forumId(database, "site-feedback"),
          title: "All types reaction",
          bodyMd: "Body.",
        }),
      );
      await database.sql`
        INSERT INTO core.notifications (member_id, type, topic_id, count)
        VALUES
          (${member}, 'member.promoted', NULL, 1),
          (${member}, 'reaction.added', ${reactionTopic.topicId}, 1)
      `;

      const since = new Date(Date.now() - 60 * 60 * 1_000);
      const kindsFor = async (): Promise<Set<string>> => {
        const items = await digestItems(worker, member, { since });
        return new Set(items.map((item) => item.kind));
      };

      expect(await kindsFor()).toEqual(
        new Set(["topic", "reply", "mention", "quote", "promotion", "reaction"]),
      );

      for (const [kind, type] of [
        ["topic", "topic.created"],
        ["reply", "topic.reply"],
        ["mention", "post.mention"],
        ["quote", "post.quote"],
        ["promotion", "member.promoted"],
        ["reaction", "reaction.added"],
      ] as const) {
        await setNotificationPreference(database.sql, member, type, "digest", false);
        expect(await kindsFor()).not.toContain(kind);
        await setNotificationPreference(database.sql, member, type, "digest", true);
      }
    });
  }, 60_000);

  test("the workers role has the digest privileges it needs", async () => {
    await withMailStack(async ({ worker }) => {
      const [privileges] = (await worker`
        SELECT
          has_table_privilege('workers', 'core.digest_subscriptions', 'SELECT') AS read,
          has_column_privilege('workers', 'core.digest_subscriptions', 'last_sent_at', 'UPDATE') AS update_last_sent,
          has_column_privilege('workers', 'core.digest_subscriptions', 'updated_at', 'UPDATE') AS update_updated_at,
          has_column_privilege('workers', 'core.digest_subscriptions', 'frequency', 'UPDATE') AS update_frequency
      `) as Array<Record<string, boolean>>;

      expect(privileges).toEqual({
        read: true,
        update_last_sent: true,
        update_updated_at: true,
        update_frequency: false,
      });
    });
  }, 30_000);

  test("a disabled mention does not suppress an enabled reply in the same topic", async () => {
    await withMailStack(async ({ database, worker }) => {
      const member = await memberId(database, "member-2");
      const author = await memberId(database, "member-1");
      const forum = await forumId(database, "off-topic");

      await setNotificationPreference(database.sql, member, "topic.reply", "digest", true);
      await setNotificationPreference(database.sql, member, "post.mention", "digest", false);

      const topic = await expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Mixed digest topic",
          bodyMd: "Body.",
        }),
      );
      await follow(database.sql, { memberId: member, kind: "topic", id: topic.topicId });
      await database.sql`
        UPDATE core.posts SET created_at = now() - interval '10 days' WHERE id = ${topic.postId}
      `;
      await expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: `Hello @[Regular Member Two](member:${member})`,
        }),
      );

      const items = await digestItems(worker, member, {
        since: new Date(Date.now() - 60 * 60 * 1_000),
      });
      expect(items).toEqual([
        expect.objectContaining({ kind: "reply", title: "Mixed digest topic" }),
      ]);
    });
  }, 60_000);

  test("only subscribed members are queued, with the right cadence", async () => {
    await withMailStack(async ({ database, worker }) => {
      const member = await memberId(database, "member-2");
      const daily = await memberId(database, "member-fr");

      await setDigestFrequency(database.sql, member, "weekly");
      await setDigestFrequency(database.sql, daily, "daily");

      expect(await queueDigests(worker, "weekly")).toHaveLength(1);
      expect(await queueDigests(worker, "daily")).toHaveLength(1);
    });
  }, 30_000);

  test("registers both crons and the per-member email queue", async () => {
    await withMailStack(async ({ database, options }) => {
      const calls: string[] = [];
      const boss = {
        getQueue: async () => null,
        createQueue: async (name: string) => {
          calls.push(`create:${name}`);
        },
        updateQueue: async (name: string) => {
          calls.push(`update:${name}`);
        },
        work: async (name: string) => {
          calls.push(`work:${name}`);
        },
        schedule: async (name: string, cron: string) => {
          calls.push(`schedule:${name}:${cron}`);
        },
        send: async (name: string) => {
          calls.push(`send:${name}`);
        },
        offWork: async (name: string) => {
          calls.push(`off:${name}`);
        },
      } as unknown as PgBoss;

      const jobs = await createDigestJobs({ ...options, boss, sql: database.sql });

      expect(calls).toContain("schedule:digest.daily:0 7 * * *");
      expect(calls).toContain("schedule:digest.weekly:0 7 * * 1");
      expect(calls).toContain("work:digest.email");
      await jobs.stop();
    });
  }, 30_000);

  test("the API saves a validated digest frequency", async () => {
    await withMailStack(async ({ database }) => {
      const member = await memberId(database, "member-2");

      const saved = await notificationDigestResponse(
        database.sql,
        member,
        new Request("http://user.test/api/notifications/digest", {
          method: "POST",
          body: JSON.stringify({ frequency: "weekly" }),
        }),
      );
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({ ok: true, frequency: "weekly" });
      expect(await digestFrequency(database.sql, member)).toBe("weekly");

      const invalid = await notificationDigestResponse(
        database.sql,
        member,
        new Request("http://user.test/api/notifications/digest", {
          method: "POST",
          body: JSON.stringify({ frequency: "hourly" }),
        }),
      );
      expect(invalid.status).toBe(400);
    });
  }, 30_000);
});
