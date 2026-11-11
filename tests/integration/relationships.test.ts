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
import { loadEvent, type StoredEvent } from "@bulletin/domain/events";
import {
  GUEST_PRINCIPAL,
  loadForumTree,
  loadPermissionSnapshot,
} from "@bulletin/domain/permissions";
import {
  friendsForMember,
  ignoredMemberIds,
  ignoreMember,
  ignoreRecipientFilter,
  readMemberRelationshipState,
  removeFriend,
  respondToFriendRequest,
  sendFriendRequest,
} from "@bulletin/domain/relationships";
import { reply, startTopic } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { friendResponse } from "../../apps/user-api/src/relationships.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { buildProfilePage } from "../../apps/user-app/src/profiles/page.ts";
import {
  createNotificationsEventHandler,
  eligibleRecipients,
} from "../../apps/workers/src/notifications.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "relationships" }, async (database) => {
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

integrationDescribe("member relationships", () => {
  test("rejects ignoring staff, and collapses a normal ignore through the overlay ids", async () => {
    await withDb(async (database) => {
      const viewer = await memberId(database, "member-1");
      const ignored = await memberId(database, "member-2");
      const admin = await memberId(database, "admin");

      expect((await ignoreMember(database.sql, { memberId: viewer, ignoredId: admin })).code).toBe(
        "unignorable",
      );

      expect((await ignoreMember(database.sql, { memberId: viewer, ignoredId: ignored })).ok).toBe(
        true,
      );

      expect(await ignoredMemberIds(database.sql, viewer)).toEqual([ignored]);
      expect(await readMemberRelationshipState(database.sql, viewer, ignored)).toMatchObject({
        ignoring: true,
        canIgnore: true,
        self: false,
      });
      expect(await readMemberRelationshipState(database.sql, viewer, admin)).toMatchObject({
        canIgnore: false,
      });
      // The ignored member sees nothing about being ignored (ignore is private).
      expect(await readMemberRelationshipState(database.sql, ignored, viewer)).toMatchObject({
        ignoring: false,
        friendState: "none",
      });
    });
  }, 30_000);

  test("an ignored member's mention delivers no notification", async () => {
    await withDb(async (database) => {
      const forum = await forumId(database, "off-topic");
      const author = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");

      await ignoreMember(database.sql, { memberId: recipient, ignoredId: author });

      const topic = await startTopic(database.sql, {
        actorId: recipient,
        forumId: forum,
        title: "Ignore mention fixture",
        bodyMd: "Body.",
      });

      if (!topic.ok) {
        throw new Error("Could not create the fixture topic");
      }

      await reply(database.sql, {
        actorId: author,
        topicId: topic.result.topicId,
        bodyMd: `Hello @[Regular Member Two](member:${recipient})`,
      });

      const event = await latestEvent(database, "post.created");
      const unfiltered = await eligibleRecipients({ sql: database.sql }, event);

      expect(unfiltered.some((entry) => entry.memberId === recipient)).toBe(true);

      await createNotificationsEventHandler({
        sql: database.sql,
        filters: [ignoreRecipientFilter],
      })(event);

      const rows = (await database.sql`
        SELECT 1 FROM core.notifications
        WHERE member_id = ${recipient} AND type = 'post.mention'
      `) as unknown[];
      expect(rows).toEqual([]);
    });
  }, 30_000);

  test("friend requests can be accepted, notified, listed and removed", async () => {
    await withDb(async (database) => {
      const first = await memberId(database, "member-1");
      const second = await memberId(database, "member-2");

      expect(
        (await sendFriendRequest(database.sql, { memberId: first, targetId: second })).ok,
      ).toBe(true);
      expect(await readMemberRelationshipState(database.sql, first, second)).toMatchObject({
        friendState: "pending_out",
      });
      expect(await readMemberRelationshipState(database.sql, second, first)).toMatchObject({
        friendState: "pending_in",
      });

      const accepted = await respondToFriendRequest(database.sql, {
        memberId: second,
        requesterId: first,
        accept: true,
      });
      expect(accepted.ok).toBe(true);

      expect((await friendsForMember(database.sql, first)).map((friend) => friend.id)).toEqual([
        second,
      ]);
      expect((await friendsForMember(database.sql, second)).map((friend) => friend.id)).toEqual([
        first,
      ]);

      const event = await latestEvent(database, "friend.accepted");
      await createNotificationsEventHandler({ sql: database.sql })(event);

      const [notification] = (await database.sql`
        SELECT type, actor_id::text AS actor_id
        FROM core.notifications
        WHERE member_id = ${first}
      `) as Array<{ type: string; actor_id: string }>;
      expect(notification).toEqual({ type: "friend.accepted", actor_id: second });

      expect((await removeFriend(database.sql, { memberId: first, friendId: second })).ok).toBe(
        true,
      );
      expect(await friendsForMember(database.sql, first)).toEqual([]);
    });
  }, 30_000);

  test("a hidden friend list is absent from the profile view model", async () => {
    await withDb(async (database) => {
      const first = await memberId(database, "member-1");
      const second = await memberId(database, "member-2");

      await sendFriendRequest(database.sql, { memberId: first, targetId: second });
      await respondToFriendRequest(database.sql, {
        memberId: second,
        requesterId: first,
        accept: true,
      });

      const tree = await loadForumTree(database.sql);
      const snapshot = await loadPermissionSnapshot(database.sql, GUEST_PRINCIPAL, {
        tree,
        sessionId: null,
      });
      const visible = await buildProfilePage({
        sql: database.sql,
        memberId: first,
        principal: GUEST_PRINCIPAL,
        sessionId: null,
        tree,
        snapshot,
        locale: "en",
        translate,
      });
      expect(visible?.viewModel.profile.friends.map((friend) => friend.id)).toEqual([second]);

      await database.sql`
        UPDATE core.members SET hide_friends = true WHERE id = ${first}
      `;

      const hidden = await buildProfilePage({
        sql: database.sql,
        memberId: first,
        principal: GUEST_PRINCIPAL,
        sessionId: null,
        tree,
        snapshot,
        locale: "en",
        translate,
      });
      expect(hidden?.viewModel.profile.friends).toEqual([]);
    });
  }, 30_000);

  test("a target's private ignore list is not revealed by a friend request", async () => {
    await withDb(async (database) => {
      const caller = await memberId(database, "member-1");
      const target = await memberId(database, "member-2");
      await ignoreMember(database.sql, { memberId: target, ignoredId: caller });

      const response = await friendResponse(
        database.sql,
        { memberId: caller, id: "0" } as never,
        new Request("http://bulletin.localhost/api/friends", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "request", memberId: target }),
        }),
      );

      expect(response.status).toBe(200);
      expect(await readMemberRelationshipState(database.sql, caller, target)).toMatchObject({
        friendState: "pending_out",
      });
      // The target still sees the request; ignore remains private.
      expect(await readMemberRelationshipState(database.sql, target, caller)).toMatchObject({
        friendState: "pending_in",
        ignoring: true,
      });
    });
  }, 30_000);
});
