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
  themesSeedModule,
} from "@bulletin/db/seed";
import { createAuthService, hashToken, sessionCookieName } from "@bulletin/domain/auth";
import { emit, loadEvent } from "@bulletin/domain/events";
import {
  createNotification,
  createNotificationEmailIntent,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  notificationChannels,
  notificationEmailContext,
  notificationPreferenceMatrix,
  setNotificationPreference,
  unreadNotificationCount,
} from "@bulletin/domain/notifications";
import { bumpPermVersion, forumActionMask } from "@bulletin/domain/permissions";
import { reply, startTopic } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { authIssuer, userOrigin } from "@bulletin/test-utils/urls";
import { SQL } from "bun";
import {
  notificationPreferencesResponse,
  notificationReadResponse,
} from "../../apps/user-api/src/notifications.ts";
import { buildNotificationPreferencesPage } from "../../apps/user-app/src/account/notification-preferences.ts";
import { buildNotificationsPage } from "../../apps/user-app/src/account/notifications.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { createNotificationsEventHandler } from "../../apps/workers/src/notifications.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const SESSION_SECRET = "notifications-test-secret";
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "notifications_centre" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        themesSeedModule,
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

async function latestPostEvent(database: TestDatabase): Promise<bigint> {
  const [row] = (await database.sql`
    SELECT id FROM core.events WHERE type = 'post.created' ORDER BY id DESC LIMIT 1
  `) as Array<{ id: bigint | string }>;

  if (row === undefined) {
    throw new Error("No post event");
  }

  return BigInt(row.id);
}

interface TopicFixture {
  readonly topicId: string;
  readonly forumId: string;
  readonly postId: string;
  readonly starter: string;
  readonly actor: string;
}

async function topicFixture(
  database: TestDatabase,
  forumSlug = "off-topic",
  starterSub = "member-2",
  actorSub = "member-1",
): Promise<TopicFixture> {
  const forum = await forumId(database, forumSlug);
  const starter = await memberId(database, starterSub);
  const actor = await memberId(database, actorSub);
  const topic = expectOk(
    await startTopic(database.sql, {
      actorId: starter,
      forumId: forum,
      title: "Centre topic",
      bodyMd: "Body.",
    }),
  );
  const post = expectOk(
    await reply(database.sql, {
      actorId: actor,
      topicId: topic.topicId,
      bodyMd: "A reply.",
    }),
  );

  return {
    topicId: topic.topicId,
    forumId: forum,
    postId: post.postId,
    starter,
    actor,
  };
}

async function notify(
  database: TestDatabase,
  fixture: TopicFixture,
  memberIdValue: string,
): Promise<bigint> {
  const eventId = await latestPostEvent(database);
  const id = await createNotification(database.sql, {
    memberId: memberIdValue,
    type: "topic.reply",
    eventId,
    actorId: fixture.actor,
    topicId: fixture.topicId,
    forumId: fixture.forumId,
    postId: fixture.postId,
  });

  if (id === null) {
    throw new Error("Notification was deduplicated");
  }

  return id;
}

interface OverlayPayload {
  readonly counts?: { readonly notifications?: number };
}

async function overlayAuth(database: TestDatabase) {
  const url = new URL(database.url);
  url.username = "user_api";
  url.password = "";
  const sql = new SQL(url.toString());
  const auth = await createAuthService({
    sql,
    kind: "user",
    issuer: authIssuer(),
    jwksUrl: "http://127.0.0.1:1/jwks.json",
    clientId: "bulletin-user",
    origin: userOrigin(),
    sessionSecret: SESSION_SECRET,
    nodeEnv: "test",
    cacheTtlMs: 0,
  });

  return {
    auth,
    close: async () => {
      await auth.close();
      await sql.close();
    },
  };
}

async function sessionCookie(database: TestDatabase, memberIdValue: string): Promise<string> {
  const token = `notifications-${crypto.randomUUID()}`;
  await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (${memberIdValue}, 'user', ${hashToken(token)}, now() + interval '1 day')
  `;
  return `${sessionCookieName("user", "test")}=${token}`;
}

async function overlayCount(
  database: TestDatabase,
  harness: Awaited<ReturnType<typeof overlayAuth>>,
  memberIdValue: string,
): Promise<number> {
  const response = await harness.auth.handle(
    new Request(`${userOrigin()}/api/me/overlay`, {
      method: "POST",
      headers: {
        cookie: await sessionCookie(database, memberIdValue),
        origin: userOrigin(),
        "content-type": "application/json",
        "x-bulletin-overlay": "1",
      },
      body: JSON.stringify({ ctx: "board" }),
    }),
  );

  expect(response?.status).toBe(200);
  const payload = (await response?.json()) as OverlayPayload;
  return payload.counts?.notifications ?? -1;
}

integrationDescribe("notification centre", () => {
  test("lists entries, marks one read and clears the unread count", async () => {
    await withSeededDb(async (database) => {
      const fixture = await topicFixture(database);
      const notificationId = await notify(database, fixture, fixture.starter);

      const entries = await listNotifications(database.sql, fixture.starter);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: notificationId.toString(),
        type: "topic.reply",
        actorName: "Regular Member One",
        topicTitle: "Centre topic",
        postId: fixture.postId,
        count: 1,
        read: false,
      });

      expect(await unreadNotificationCount(database.sql, fixture.starter)).toBe(1);
      expect(
        await markNotificationRead(database.sql, fixture.starter, notificationId.toString()),
      ).toBe(true);
      expect(await unreadNotificationCount(database.sql, fixture.starter)).toBe(0);

      const after = await listNotifications(database.sql, fixture.starter);
      expect(after[0]?.read).toBe(true);

      const page = await buildNotificationsPage({
        sql: database.sql,
        memberId: fixture.starter,
        sessionId: null,
        locale: "en",
        translate,
      });
      expect(page.viewModel.hasNotifications).toBe(true);
      expect(page.viewModel.unreadCount).toBe(0);
      expect(page.viewModel.readAllDisabled).toBe(true);
      expect(page.viewModel.sections[0]?.entries[0]?.href).toMatch(/^\/topic\/\d+-/);
    });
  }, 30_000);

  test("marking all read only touches the member's own rows", async () => {
    await withSeededDb(async (database) => {
      const fixture = await topicFixture(database);
      const other = await memberId(database, "member-fr");
      await notify(database, fixture, fixture.starter);
      await notify(database, fixture, other);

      expect(await markAllNotificationsRead(database.sql, fixture.starter)).toBe(1);
      expect(await unreadNotificationCount(database.sql, fixture.starter)).toBe(0);
      expect(await unreadNotificationCount(database.sql, other)).toBe(1);
    });
  }, 30_000);

  test("hides entries and counts for content the member can no longer read", async () => {
    await withSeededDb(async (database) => {
      const fixture = await topicFixture(database, "staff-room", "super-mod", "admin");
      const member = await memberId(database, "super-mod");
      await notify(database, fixture, member);

      expect((await listNotifications(database.sql, member)).length).toBe(1);
      expect(await unreadNotificationCount(database.sql, member)).toBe(1);

      await database.sql`
        UPDATE core.forum_permissions fp
        SET actions = ${forumActionMask(["show"])}
        FROM core.forums f, core.masks m
        WHERE fp.forum_id = f.id AND fp.mask_id = m.id
          AND f.slug = 'staff-area' AND m.key = 'staff'
      `;
      await bumpPermVersion(database.sql);

      expect(await listNotifications(database.sql, member)).toEqual([]);
      expect(await unreadNotificationCount(database.sql, member)).toBe(0);
    });
  }, 30_000);

  test("moving a topic into a hidden forum hides its notifications and email", async () => {
    await withSeededDb(async (database) => {
      const fixture = await topicFixture(database);
      const notificationId = await notify(database, fixture, fixture.starter);
      const intentId = await createNotificationEmailIntent(
        database.sql,
        fixture.starter,
        notificationId,
        await latestPostEvent(database),
      );
      const staffRoom = await forumId(database, "staff-room");

      expect(
        await notificationEmailContext(database.sql, intentId?.toString() ?? "0"),
      ).not.toBeNull();
      await database.sql`
        UPDATE core.topics SET forum_id = ${staffRoom} WHERE id = ${fixture.topicId}
      `;

      expect(await listNotifications(database.sql, fixture.starter)).toEqual([]);
      expect(await unreadNotificationCount(database.sql, fixture.starter)).toBe(0);
      expect(await notificationEmailContext(database.sql, intentId?.toString() ?? "0")).toBeNull();
    });
  }, 30_000);

  test("a soft-deleted post disappears from the list, count and email", async () => {
    await withSeededDb(async (database) => {
      const fixture = await topicFixture(database);
      const notificationId = await notify(database, fixture, fixture.starter);
      const intentId = await createNotificationEmailIntent(
        database.sql,
        fixture.starter,
        notificationId,
        await latestPostEvent(database),
      );
      await database.sql`
        UPDATE core.posts SET visibility = 'soft_deleted' WHERE id = ${fixture.postId}
      `;

      expect(await listNotifications(database.sql, fixture.starter)).toEqual([]);
      expect(await unreadNotificationCount(database.sql, fixture.starter)).toBe(0);
      expect(await notificationEmailContext(database.sql, intentId?.toString() ?? "0")).toBeNull();
    });
  }, 30_000);

  test("pagination reaches an old unread entry beyond the first page", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      await database.sql`
        INSERT INTO core.notifications (member_id, type, count, read_at, created_at, updated_at)
        SELECT ${member}, 'member.promoted', 1, now(), now(), now()
        FROM generate_series(1, 100)
      `;
      await database.sql`
        INSERT INTO core.notifications (member_id, type, count, read_at, created_at, updated_at)
        VALUES (${member}, 'member.promoted', 1, NULL, now() - interval '1 day', now() - interval '1 day')
      `;

      const first = await buildNotificationsPage({
        sql: database.sql,
        memberId: member,
        sessionId: null,
        locale: "en",
        translate,
        page: 1,
      });

      expect(first.viewModel.unreadCount).toBe(1);
      expect(first.viewModel.readAllDisabled).toBe(false);
      expect(first.viewModel.pagination).toMatchObject({
        page: 1,
        hasPrevious: false,
        hasNext: true,
      });
      expect(first.viewModel.sections.flatMap((section) => section.entries)).toHaveLength(50);

      const third = await buildNotificationsPage({
        sql: database.sql,
        memberId: member,
        sessionId: null,
        locale: "en",
        translate,
        page: 3,
      });

      expect(third.viewModel.unreadCount).toBe(1);
      expect(third.viewModel.pagination).toMatchObject({
        page: 3,
        hasPrevious: true,
        hasNext: false,
      });
      const lastEntries = third.viewModel.sections.flatMap((section) => section.entries);
      expect(lastEntries).toHaveLength(1);
      expect(lastEntries[0]).toMatchObject({ unread: true, unreadAttr: "true" });
    });
  }, 60_000);

  test("the overlay carries the unread count for the bell", async () => {
    await withSeededDb(async (database) => {
      const fixture = await topicFixture(database);
      await notify(database, fixture, fixture.starter);
      const harness = await overlayAuth(database);

      try {
        expect(await overlayCount(database, harness, fixture.starter)).toBe(1);
        await markAllNotificationsRead(database.sql, fixture.starter);
        expect(await overlayCount(database, harness, fixture.starter)).toBe(0);
      } finally {
        await harness.close();
      }
    });
  }, 30_000);

  test("the read API scopes writes to the session member", async () => {
    await withSeededDb(async (database) => {
      const fixture = await topicFixture(database);
      const notificationId = await notify(database, fixture, fixture.starter);
      const other = await memberId(database, "member-fr");

      const denied = await notificationReadResponse(
        database.sql,
        other,
        new Request("http://user.test/api/notifications/read", {
          method: "POST",
          body: JSON.stringify({ id: notificationId.toString() }),
        }),
      );
      expect(denied.status).toBe(404);
      expect(await unreadNotificationCount(database.sql, fixture.starter)).toBe(1);

      const read = await notificationReadResponse(
        database.sql,
        fixture.starter,
        new Request("http://user.test/api/notifications/read", {
          method: "POST",
          body: JSON.stringify({ id: notificationId.toString() }),
        }),
      );
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual({ ok: true, updated: 1 });

      const invalid = await notificationReadResponse(
        database.sql,
        fixture.starter,
        new Request("http://user.test/api/notifications/read", {
          method: "POST",
          body: JSON.stringify({ id: "x" }),
        }),
      );
      expect(invalid.status).toBe(400);

      expectOk(
        await reply(database.sql, {
          actorId: fixture.actor,
          topicId: fixture.topicId,
          bodyMd: "Another reply.",
        }),
      );
      await notify(database, fixture, fixture.starter);
      const all = await notificationReadResponse(
        database.sql,
        fixture.starter,
        new Request("http://user.test/api/notifications/read", {
          method: "POST",
          body: JSON.stringify({ all: true }),
        }),
      );
      expect(all.status).toBe(200);
      expect(await all.json()).toEqual({ ok: true, updated: 1 });
    });
  }, 30_000);

  test("preferences default on for immediate channels and off for digests", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const matrix = await notificationPreferenceMatrix(database.sql, member);

      expect(matrix["topic.reply"]).toEqual({
        in_app: true,
        email: true,
        digest: false,
        push: false,
      });

      await setNotificationPreference(database.sql, member, "topic.reply", "email", false);
      await setNotificationPreference(database.sql, member, "reaction.added", "digest", true);

      expect(await notificationChannels(database.sql, member, "topic.reply")).toEqual({
        in_app: true,
        email: false,
        digest: false,
        push: false,
      });
      expect(await notificationChannels(database.sql, member, "reaction.added")).toEqual({
        in_app: true,
        email: true,
        digest: true,
        push: false,
      });
    });
  }, 30_000);

  test("in-app preferences hide a type from the centre and the bell", async () => {
    await withSeededDb(async (database) => {
      const fixture = await topicFixture(database);
      await notify(database, fixture, fixture.starter);

      expect((await listNotifications(database.sql, fixture.starter)).length).toBe(1);
      expect(await unreadNotificationCount(database.sql, fixture.starter)).toBe(1);

      await setNotificationPreference(
        database.sql,
        fixture.starter,
        "topic.reply",
        "in_app",
        false,
      );

      expect(await listNotifications(database.sql, fixture.starter)).toEqual([]);
      expect(await unreadNotificationCount(database.sql, fixture.starter)).toBe(0);
    });
  }, 30_000);

  test("the subscriber drops a recipient with every channel disabled", async () => {
    await withSeededDb(async (database) => {
      const fixture = await topicFixture(database);

      for (const channel of ["in_app", "email", "digest", "push"] as const) {
        await setNotificationPreference(
          database.sql,
          fixture.starter,
          "topic.reply",
          channel,
          false,
        );
      }

      const eventId = await latestPostEvent(database);
      const [row] = (await database.sql`
        SELECT id FROM core.events WHERE id = ${eventId}
      `) as Array<{ id: bigint | string }>;
      const event = await loadEvent(database.sql, BigInt(row?.id ?? 0));

      if (event === null) {
        throw new Error("Missing event");
      }

      await createNotificationsEventHandler({ sql: database.sql })(event);
      expect(await listNotifications(database.sql, fixture.starter)).toEqual([]);
      expect(await unreadNotificationCount(database.sql, fixture.starter)).toBe(0);
    });
  }, 30_000);

  test("an unreadable entry cannot end pagination before older visible entries", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const visible = await topicFixture(database);
      const hidden = await topicFixture(database, "staff-room", "super-mod", "admin");

      await database.sql`
        INSERT INTO core.notifications (
          member_id, type, topic_id, forum_id, post_id, count, read_at, created_at, updated_at
        )
        SELECT ${member}, 'topic.reply', ${visible.topicId}, ${visible.forumId},
          ${visible.postId}, 1, now(), now() - interval '1 hour', now() - interval '1 hour'
        FROM generate_series(1, 60)
      `;
      // Newest row points at a forum this member cannot read.
      await database.sql`
        INSERT INTO core.notifications (
          member_id, type, topic_id, forum_id, post_id, count, read_at, created_at, updated_at
        )
        VALUES (
          ${member}, 'topic.reply', ${hidden.topicId}, ${hidden.forumId},
          ${hidden.postId}, 1, now(), now(), now()
        )
      `;

      const first = await buildNotificationsPage({
        sql: database.sql,
        memberId: member,
        sessionId: null,
        locale: "en",
        translate,
        page: 1,
      });
      expect(first.viewModel.pagination).toMatchObject({ page: 1, hasNext: true });
      expect(first.viewModel.sections.flatMap((section) => section.entries)).toHaveLength(50);

      const second = await buildNotificationsPage({
        sql: database.sql,
        memberId: member,
        sessionId: null,
        locale: "en",
        translate,
        page: 2,
      });
      expect(second.viewModel.pagination).toMatchObject({
        page: 2,
        hasPrevious: true,
        hasNext: false,
      });
      const entries = second.viewModel.sections.flatMap((section) => section.entries);
      expect(entries).toHaveLength(10);
      expect(entries.every((entry) => entry.href?.startsWith("/topic/") === true)).toBe(true);
    });
  }, 30_000);

  test("coalesces reputation notifications per post and renders the plural text", async () => {
    await withSeededDb(async (database) => {
      const fixture = await topicFixture(database);
      const other = await memberId(database, "member-fr");

      for (const giver of [fixture.actor, other]) {
        const eventId = await database.sql.begin(async (tx) => {
          const id = await emit(tx, {
            type: "reputation.given",
            aggregateId: BigInt(fixture.starter),
            aggregateVersion: 1n,
            payloadIds: {
              entryId: BigInt(1),
              postId: BigInt(fixture.postId),
              giverId: BigInt(giver),
              receiverId: BigInt(fixture.starter),
            },
          });
          return id;
        });

        await createNotification(database.sql, {
          memberId: fixture.starter,
          type: "reputation.given",
          eventId,
          actorId: giver,
          topicId: fixture.topicId,
          forumId: fixture.forumId,
          postId: fixture.postId,
        });
      }

      const page = await buildNotificationsPage({
        sql: database.sql,
        memberId: fixture.starter,
        sessionId: null,
        locale: "en",
        translate,
      });
      const entries = page.viewModel.sections.flatMap((section) => section.entries);

      expect(entries).toHaveLength(1);
      expect(entries[0]?.text).toContain("2 reputation points received");
      // The giver stays anonymous in member-facing text (ADR 0012).
      expect(entries[0]?.text).not.toContain("Regular Member One");
      expect(entries[0]?.href).toContain(`/post/${fixture.postId}`);
    });
  }, 30_000);

  test("the preferences page lists every type and channel", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const page = await buildNotificationPreferencesPage({
        sql: database.sql,
        memberId: member,
        translate,
        pushEnabled: true,
      });

      expect(page.viewModel.types).toHaveLength(NOTIFICATION_TYPES.length);
      expect(
        page.viewModel.types.every((type) => type.channels.length === NOTIFICATION_CHANNELS.length),
      ).toBe(true);
      expect(page.viewModel.digestOptions.map((option) => option.value)).toEqual([
        "off",
        "daily",
        "weekly",
      ]);
    });
  }, 30_000);

  test("the preferences API validates type, channel and scope", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");

      const saved = await notificationPreferencesResponse(
        database.sql,
        member,
        new Request("http://user.test/api/notifications/preferences", {
          method: "POST",
          body: JSON.stringify({ type: "post.mention", channel: "email", enabled: false }),
        }),
      );
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual({
        ok: true,
        preference: { type: "post.mention", channel: "email", enabled: false },
      });
      expect(await notificationChannels(database.sql, member, "post.mention")).toEqual({
        in_app: true,
        email: false,
        digest: false,
        push: false,
      });

      const pushSaved = await notificationPreferencesResponse(
        database.sql,
        member,
        new Request("http://user.test/api/notifications/preferences", {
          method: "POST",
          body: JSON.stringify({ type: "post.mention", channel: "push", enabled: true }),
        }),
        { pushEnabled: true },
      );
      expect(pushSaved.status).toBe(200);
      expect((await notificationChannels(database.sql, member, "post.mention")).push).toBe(true);

      for (const body of [
        { type: "unknown", channel: "email", enabled: true },
        { type: "post.mention", channel: "sms", enabled: true },
        { type: "post.mention", channel: "email", enabled: "yes" },
      ]) {
        const response = await notificationPreferencesResponse(
          database.sql,
          member,
          new Request("http://user.test/api/notifications/preferences", {
            method: "POST",
            body: JSON.stringify(body),
          }),
        );
        expect(response.status).toBe(400);
      }
    });
  }, 30_000);

  test("emits no notification row of another member's type", async () => {
    await withSeededDb(async (database) => {
      // The notification_events dedupe key keeps a replayed event from counting twice.
      const fixture = await topicFixture(database);
      const eventId = await latestPostEvent(database);
      const write = {
        memberId: fixture.starter,
        type: "topic.reply" as const,
        eventId,
        actorId: fixture.actor,
        topicId: fixture.topicId,
        forumId: fixture.forumId,
        postId: fixture.postId,
      };

      expect(await createNotification(database.sql, write)).not.toBeNull();
      expect(await createNotification(database.sql, write)).toBeNull();
      expect(await unreadNotificationCount(database.sql, fixture.starter)).toBe(1);
    });
  }, 30_000);
});
