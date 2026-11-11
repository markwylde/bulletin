import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_REMOVAL_CRON,
  CONVERSATION_REMOVAL_QUEUE,
  createConversationJobs,
  runConversationRemoval,
} from "@bulletin/db/jobs";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { refreshMemberStorage } from "@bulletin/domain/attachments";
import {
  inviteConversationParticipant,
  leaveConversation,
  listConversations,
  readConversationForParticipant,
  readStartUsage,
  replyToConversation,
  searchConversations,
  startConversation,
} from "@bulletin/domain/conversations";
import { insertIgnore } from "@bulletin/domain/relationships";
import { createServerT } from "@bulletin/i18n";
import { type StorageClient, thumbnailKeyFor } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import type { PgBoss } from "pg-boss";
import {
  archiveConversationResponse,
  conversationResponse,
  createConversationResponse,
  leaveConversationResponse,
  participantResponse,
  readConversationResponse,
  replyConversationResponse,
} from "../../apps/user-api/src/conversations.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { buildInboxPage } from "../../apps/user-app/src/conversations/page.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "conversations" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
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

async function setGroupSetting(
  database: TestDatabase,
  groupKey: string,
  key: string,
  value: boolean | number,
): Promise<void> {
  if (typeof value === "boolean") {
    await database.sql`
      INSERT INTO core.group_settings (group_id, key, value)
      SELECT id, ${key}, to_jsonb(${value}::boolean)
      FROM core.groups WHERE key = ${groupKey}
      ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
    return;
  }

  await database.sql`
    INSERT INTO core.group_settings (group_id, key, value)
    SELECT id, ${key}, to_jsonb(${value}::int)
    FROM core.groups WHERE key = ${groupKey}
    ON CONFLICT (group_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

function session(memberIdValue: string): { readonly memberId: string } {
  return { memberId: memberIdValue };
}

function postRequest(body: unknown): Request {
  return new Request("http://bulletin.localhost/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function pmSentEvents(database: TestDatabase): Promise<
  readonly {
    readonly aggregateId: string;
    readonly aggregateVersion: string;
    readonly payload: Readonly<Record<string, string>>;
  }[]
> {
  const rows = (await database.sql`
    SELECT aggregate_id::text AS aggregate_id, aggregate_version::text AS aggregate_version,
      payload_ids
    FROM core.events
    WHERE type = 'pm.sent'
    ORDER BY id
  `) as Array<{
    aggregate_id: string;
    aggregate_version: string;
    payload_ids: unknown;
  }>;

  return rows.map((row) => ({
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    payload:
      typeof row.payload_ids === "string"
        ? (JSON.parse(row.payload_ids) as Record<string, string>)
        : (row.payload_ids as Record<string, string>),
  }));
}

async function conversationCount(database: TestDatabase): Promise<number> {
  const [row] = (await database.sql`
    SELECT count(*)::int AS count FROM core.conversations
  `) as Array<{ count: number }>;

  return row?.count ?? 0;
}

async function startFixture(
  database: TestDatabase,
  input: {
    readonly starter: string;
    readonly recipients: readonly string[];
    readonly title?: string;
  },
): Promise<string> {
  const outcome = await startConversation(database.sql, {
    actorId: input.starter,
    title: input.title ?? "Fixture conversation",
    bodyMd: "First message.",
    recipientIds: input.recipients,
  });

  if (!outcome.ok) {
    throw new Error(`Could not start the conversation: ${outcome.code}`);
  }

  return outcome.result.conversationId;
}

integrationDescribe("conversation access", () => {
  test("only active participants read a conversation; an admin without a report gets 404", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const outsider = await memberId(database, "new-member");
      const admin = await memberId(database, "admin");

      const started = await startConversation(database.sql, {
        actorId: starter,
        title: "A private plan",
        bodyMd: "Only the two of us.",
        recipientIds: [recipient],
      });

      if (!started.ok) {
        throw new Error(`Could not start the conversation: ${started.code}`);
      }

      const conversationId = started.result.conversationId;
      const seen = await conversationResponse(database.sql, session(starter), conversationId);

      expect(seen.status).toBe(200);
      expect(seen.headers.get("cache-control")).toBe("private, no-store");
      const detail = (await seen.json()) as {
        id: string;
        title: string;
        participants: Array<{ id: string }>;
        messages: Array<{ bodyHtml: string }>;
      };
      expect(detail.id).toBe(conversationId);
      expect(detail.title).toBe("A private plan");
      expect(detail.participants.map((participant) => participant.id).sort()).toEqual(
        [starter, recipient].sort(),
      );
      expect(detail.messages[0]?.bodyHtml).toContain("Only the two of us.");

      for (const unauthorised of [outsider, admin]) {
        const denied = await conversationResponse(
          database.sql,
          session(unauthorised),
          conversationId,
        );

        expect(denied.status).toBe(404);
        expect(denied.headers.get("cache-control")).toBe("private, no-store");
        expect(await denied.json()).toEqual({ code: "not_found" });
        expect(
          await readConversationForParticipant(database.sql, conversationId, unauthorised),
        ).toBeNull();
      }

      // An unknown ID is indistinguishable from an unauthorised one.
      expect((await conversationResponse(database.sql, session(starter), "999999")).status).toBe(
        404,
      );
    });
  }, 30_000);
});

integrationDescribe("starting a conversation", () => {
  test("starts a group conversation for every participant and emits pm.sent", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipients = [
        await memberId(database, "member-2"),
        await memberId(database, "member-es"),
        await memberId(database, "member-fr"),
      ];

      await setGroupSetting(database, "members", "posting.pm_recipients", 5);

      const response = await createConversationResponse(
        database.sql,
        session(starter),
        postRequest({
          title: "Four of us",
          bodyMd: "Hello **everyone**.",
          recipientIds: recipients,
        }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { conversationId: string; messageId: string };

      const participants = (await database.sql`
        SELECT member_id::text AS member_id, state, folder
        FROM core.conversation_participants
        WHERE conversation_id = ${body.conversationId}
        ORDER BY member_id
      `) as Array<{ member_id: string; state: string; folder: string }>;

      expect(participants.map((row) => row.member_id).sort()).toEqual(
        [starter, ...recipients].sort(),
      );
      expect(participants.every((row) => row.state === "active" && row.folder === "inbox")).toBe(
        true,
      );

      const messages = (await database.sql`
        SELECT body_md, body_html
        FROM core.conversation_messages
        WHERE conversation_id = ${body.conversationId}
      `) as Array<{ body_md: string; body_html: string }>;

      expect(messages).toHaveLength(1);
      expect(messages[0]?.body_md).toBe("Hello **everyone**.");
      expect(messages[0]?.body_html).toContain("<strong>everyone</strong>");

      const events = await pmSentEvents(database);
      expect(events).toHaveLength(1);
      expect(events[0]?.aggregateId).toBe(body.conversationId);
      expect(events[0]?.aggregateVersion).toBe("1");
      expect(events[0]?.payload).toEqual({
        conversationId: body.conversationId,
        messageId: body.messageId,
        senderId: starter,
      });

      // Every participant can read the same full history from the start.
      for (const participant of [starter, ...recipients]) {
        expect(
          (await readConversationForParticipant(database.sql, body.conversationId, participant))
            ?.messages,
        ).toHaveLength(1);
      }
    });
  }, 30_000);

  test("rejects more recipients than the group allows, naming the limit", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipients = [
        await memberId(database, "member-2"),
        await memberId(database, "member-es"),
        await memberId(database, "member-fr"),
      ];

      await setGroupSetting(database, "members", "posting.pm_recipients", 2);

      const response = await createConversationResponse(
        database.sql,
        session(starter),
        postRequest({ title: "Too many", bodyMd: "Body.", recipientIds: recipients }),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "recipient_limit", limit: 2 });
      expect(await conversationCount(database)).toBe(0);
      expect(await pmSentEvents(database)).toHaveLength(0);
    });
  }, 30_000);

  test("a group that disallows private messages cannot start a conversation", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");

      await setGroupSetting(database, "members", "restrictions.cannot_pm", true);

      const response = await createConversationResponse(
        database.sql,
        session(starter),
        postRequest({ title: "Blocked sender", bodyMd: "Body.", recipientIds: [recipient] }),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "pm_disabled" });
      expect(await conversationCount(database)).toBe(0);
    });
  }, 30_000);

  test("a banned member cannot start a conversation", async () => {
    await withSeededDb(async (database) => {
      const banned = await memberId(database, "banned-member");
      const recipient = await memberId(database, "member-1");

      const response = await createConversationResponse(
        database.sql,
        session(banned),
        postRequest({ title: "Banned sender", bodyMd: "Body.", recipientIds: [recipient] }),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "pm_disabled" });
      expect(await conversationCount(database)).toBe(0);
    });
  }, 30_000);

  test("a recipient whose groups disallow private messages gets the generic refusal", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");

      // A secondary group with the restriction; `restrict-any` merges it in.
      const [group] = (await database.sql`
        INSERT INTO core.groups (key, title, is_system)
        VALUES ('no_pm', 'No PM', false)
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (group === undefined) {
        throw new Error("Could not create the group");
      }

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${group.id}, 'restrictions.cannot_pm', 'true'::jsonb)
      `;
      await database.sql`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        VALUES (${recipient}, ${group.id}, false)
      `;

      const response = await createConversationResponse(
        database.sql,
        session(starter),
        postRequest({ title: "Unreachable", bodyMd: "Body.", recipientIds: [recipient] }),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "recipient_unavailable" });
      expect(await conversationCount(database)).toBe(0);
    });
  }, 30_000);

  test("a recipient who ignores the starter gets the same generic refusal", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");

      await insertIgnore(database.sql, recipient, starter);

      const response = await createConversationResponse(
        database.sql,
        session(starter),
        postRequest({ title: "Ignored", bodyMd: "Body.", recipientIds: [recipient] }),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "recipient_unavailable" });
      expect(await conversationCount(database)).toBe(0);
    });
  }, 30_000);

  test("rejects a start past the daily limit and reports when it resets", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const first = await memberId(database, "member-2");
      const second = await memberId(database, "member-es");

      await setGroupSetting(database, "members", "posting.pm_daily_starts", 1);

      const created = await createConversationResponse(
        database.sql,
        session(starter),
        postRequest({ title: "First today", bodyMd: "Body.", recipientIds: [first] }),
      );
      expect(created.status).toBe(200);

      const limited = await createConversationResponse(
        database.sql,
        session(starter),
        postRequest({ title: "Second today", bodyMd: "Body.", recipientIds: [second] }),
      );

      expect(limited.status).toBe(429);
      const body = (await limited.json()) as {
        code: string;
        limit: number;
        retryAfterSeconds: number;
      };
      expect(body.code).toBe("daily_limit");
      expect(body.limit).toBe(1);
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
      expect(await conversationCount(database)).toBe(1);
      expect(await pmSentEvents(database)).toHaveLength(1);
    });
  }, 30_000);

  test("rejects a start at the conversation quota", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const first = await memberId(database, "member-2");
      const second = await memberId(database, "member-es");

      await setGroupSetting(database, "members", "posting.pm_quota", 1);

      const created = await createConversationResponse(
        database.sql,
        session(starter),
        postRequest({ title: "One slot", bodyMd: "Body.", recipientIds: [first] }),
      );
      expect(created.status).toBe(200);

      const overQuota = await createConversationResponse(
        database.sql,
        session(starter),
        postRequest({ title: "No slot", bodyMd: "Body.", recipientIds: [second] }),
      );

      expect(overQuota.status).toBe(409);
      expect(await overQuota.json()).toEqual({ code: "quota_reached", quota: 1 });
      expect(await conversationCount(database)).toBe(1);
      expect(await pmSentEvents(database)).toHaveLength(1);
    });
  }, 30_000);

  test("rejects an empty recipient list and a missing body", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");

      const none = await createConversationResponse(
        database.sql,
        session(starter),
        postRequest({ title: "Nobody", bodyMd: "Body.", recipientIds: [] }),
      );
      expect(none.status).toBe(400);
      expect(await none.json()).toEqual({ code: "no_recipients" });

      const empty = await createConversationResponse(
        database.sql,
        session(starter),
        postRequest({
          title: "Nobody",
          bodyMd: "   ",
          recipientIds: [await memberId(database, "member-2")],
        }),
      );
      expect(empty.status).toBe(400);
      expect(await empty.json()).toEqual({ code: "invalid_body" });
      expect(await conversationCount(database)).toBe(0);
    });
  }, 30_000);
});

integrationDescribe("conversation replies and participants", () => {
  test("a participant replies, the conversation moves up and pm.sent carries the new version", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const conversationId = await startFixture(database, { starter, recipients: [recipient] });

      const response = await replyConversationResponse(
        database.sql,
        session(recipient),
        conversationId,
        postRequest({ bodyMd: "Second **reply**." }),
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as { messageId: string };
      const detail = await readConversationForParticipant(database.sql, conversationId, starter);

      expect(detail?.messages).toHaveLength(2);
      expect(detail?.messages[1]?.bodyHtml).toContain("<strong>reply</strong>");
      expect(detail?.viewer.unreadCount).toBe(1);

      const events = await pmSentEvents(database);
      expect(events).toHaveLength(2);
      expect(events[1]?.aggregateId).toBe(conversationId);
      expect(events[1]?.aggregateVersion).toBe("2");
      expect(events[1]?.payload).toEqual({
        conversationId,
        messageId: body.messageId,
        senderId: recipient,
      });

      const empty = await replyConversationResponse(
        database.sql,
        session(recipient),
        conversationId,
        postRequest({ bodyMd: "   " }),
      );
      expect(empty.status).toBe(400);
      expect(await empty.json()).toEqual({ code: "invalid_body" });
    });
  }, 30_000);

  test("non-participants and PM-disabled members cannot reply", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const outsider = await memberId(database, "new-member");
      const conversationId = await startFixture(database, { starter, recipients: [recipient] });

      const denied = await replyConversationResponse(
        database.sql,
        session(outsider),
        conversationId,
        postRequest({ bodyMd: "Not mine." }),
      );
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual({ code: "not_found" });

      const [group] = (await database.sql`
        INSERT INTO core.groups (key, title, is_system)
        VALUES ('reply_no_pm', 'No replies', false)
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (group === undefined) {
        throw new Error("Could not create the group");
      }

      await database.sql`
        INSERT INTO core.group_settings (group_id, key, value)
        VALUES (${group.id}, 'restrictions.cannot_pm', 'true'::jsonb)
      `;
      await database.sql`
        INSERT INTO core.member_groups (member_id, group_id, is_primary)
        VALUES (${recipient}, ${group.id}, false)
      `;

      const restricted = await replyConversationResponse(
        database.sql,
        session(recipient),
        conversationId,
        postRequest({ bodyMd: "Blocked." }),
      );
      expect(restricted.status).toBe(403);
      expect(await restricted.json()).toEqual({ code: "pm_disabled" });
    });
  }, 30_000);

  test("the starter invites within the recipient limit and the newcomer sees full history", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const first = await memberId(database, "member-2");
      const second = await memberId(database, "member-es");
      const third = await memberId(database, "member-fr");
      const conversationId = await startFixture(database, { starter, recipients: [first] });

      // The default recipient limit is 1, so a second recipient is refused.
      const overLimit = await participantResponse(
        database.sql,
        session(starter),
        conversationId,
        postRequest({ action: "invite", memberId: second }),
      );
      expect(overLimit.status).toBe(400);
      expect(await overLimit.json()).toEqual({ code: "recipient_limit", limit: 1 });

      await setGroupSetting(database, "members", "posting.pm_recipients", 2);

      const invited = await participantResponse(
        database.sql,
        session(starter),
        conversationId,
        postRequest({ action: "invite", memberId: second }),
      );
      expect(invited.status).toBe(200);

      const newcomer = await readConversationForParticipant(database.sql, conversationId, second);
      expect(newcomer?.messages).toHaveLength(1);
      expect(newcomer?.participants).toHaveLength(3);
      expect(newcomer?.viewer.unreadCount).toBe(1);

      const again = await participantResponse(
        database.sql,
        session(starter),
        conversationId,
        postRequest({ action: "invite", memberId: second }),
      );
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ code: "already_participant" });

      // A non-starter cannot invite, even when a slot is free.
      await setGroupSetting(database, "members", "posting.pm_recipients", 3);
      const forbidden = await participantResponse(
        database.sql,
        session(first),
        conversationId,
        postRequest({ action: "invite", memberId: third }),
      );
      expect(forbidden.status).toBe(403);
      expect(await forbidden.json()).toEqual({ code: "forbidden" });
    });
  }, 30_000);

  test("removal ends access to the history and only the starter may remove", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const other = await memberId(database, "member-es");
      const conversationId = await startFixture(database, { starter, recipients: [recipient] });

      const notStarter = await participantResponse(
        database.sql,
        session(recipient),
        conversationId,
        postRequest({ action: "remove", memberId: starter }),
      );
      expect(notStarter.status).toBe(403);
      expect(await notStarter.json()).toEqual({ code: "forbidden" });

      const self = await participantResponse(
        database.sql,
        session(starter),
        conversationId,
        postRequest({ action: "remove", memberId: starter }),
      );
      expect(self.status).toBe(400);
      expect(await self.json()).toEqual({ code: "cannot_remove_self" });

      const removed = await participantResponse(
        database.sql,
        session(starter),
        conversationId,
        postRequest({ action: "remove", memberId: recipient }),
      );
      expect(removed.status).toBe(200);

      const denied = await conversationResponse(database.sql, session(recipient), conversationId);
      expect(denied.status).toBe(404);
      expect(
        await readConversationForParticipant(database.sql, conversationId, recipient),
      ).toBeNull();

      const [row] = (await database.sql`
        SELECT state, left_at FROM core.conversation_participants
        WHERE conversation_id = ${conversationId} AND member_id = ${recipient}
      `) as Array<{ state: string; left_at: Date | null }>;
      expect(row?.state).toBe("removed");
      expect(row?.left_at).not.toBeNull();

      // A removed participant cannot be re-invited by a non-starter; the starter can.
      const reInvite = await inviteConversationParticipant(database.sql, {
        actorId: starter,
        conversationId,
        memberId: recipient,
      });
      expect(reInvite.ok).toBe(true);

      const outsiderRemove = await participantResponse(
        database.sql,
        session(other),
        conversationId,
        postRequest({ action: "remove", memberId: recipient }),
      );
      expect(outsiderRemove.status).toBe(404);
    });
  }, 30_000);

  test("leaving ends access, frees the quota slot and can block re-invites", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const conversationId = await startFixture(database, { starter, recipients: [recipient] });

      expect((await readStartUsage(database.sql, recipient)).active).toBe(1);

      const left = await leaveConversationResponse(
        database.sql,
        session(recipient),
        conversationId,
        postRequest({ blockReinvite: true }),
      );
      expect(left.status).toBe(200);

      expect((await readStartUsage(database.sql, recipient)).active).toBe(0);
      expect(
        (await conversationResponse(database.sql, session(recipient), conversationId)).status,
      ).toBe(404);
      expect(
        (
          await replyConversationResponse(
            database.sql,
            session(recipient),
            conversationId,
            postRequest({ bodyMd: "After leaving." }),
          )
        ).status,
      ).toBe(404);

      const blocked = await inviteConversationParticipant(database.sql, {
        actorId: starter,
        conversationId,
        memberId: recipient,
      });
      expect(blocked).toEqual({ ok: false, code: "invite_blocked" });

      // Without the block flag, a former participant can be invited back and sees history.
      const second = await memberId(database, "member-es");
      const secondConversation = await startFixture(database, {
        starter,
        recipients: [second],
      });
      await leaveConversation(database.sql, {
        actorId: second,
        conversationId: secondConversation,
      });
      const reinvited = await inviteConversationParticipant(database.sql, {
        actorId: starter,
        conversationId: secondConversation,
        memberId: second,
      });
      expect(reinvited.ok).toBe(true);
      expect(
        (await readConversationForParticipant(database.sql, secondConversation, second))?.messages,
      ).toHaveLength(1);
    });
  }, 30_000);
});

integrationDescribe("conversation folders and unread tracking", () => {
  test("lists inbox, sent and archive with unread counts", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");

      const sentId = await startFixture(database, {
        starter,
        recipients: [recipient],
        title: "Started by member one",
      });
      const receivedId = await startFixture(database, {
        starter: recipient,
        recipients: [starter],
        title: "Started by member two",
      });

      const lists = await listConversations(database.sql, starter);
      expect(lists.inbox.map((row) => row.id).sort()).toEqual([sentId, receivedId].sort());
      expect(lists.sent.map((row) => row.id)).toEqual([sentId]);
      expect(lists.archive).toHaveLength(0);
      expect(lists.inbox.find((row) => row.id === receivedId)?.unreadCount).toBe(1);
      expect(lists.inbox.find((row) => row.id === sentId)?.unreadCount).toBe(0);

      const recipientLists = await listConversations(database.sql, recipient);
      expect(recipientLists.sent.map((row) => row.id)).toEqual([receivedId]);
      expect(recipientLists.inbox.map((row) => row.id).sort()).toEqual([sentId, receivedId].sort());
    });
  }, 30_000);

  test("archive hides a conversation from the inbox and a reply returns it unread", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const conversationId = await startFixture(database, { starter, recipients: [recipient] });

      const archived = await archiveConversationResponse(
        database.sql,
        session(starter),
        conversationId,
        postRequest({ archived: true }),
      );
      expect(archived.status).toBe(200);
      expect(await archived.json()).toEqual({ ok: true, folder: "archive" });

      let lists = await listConversations(database.sql, starter);
      expect(lists.inbox.map((row) => row.id)).not.toContain(conversationId);
      expect(lists.archive.map((row) => row.id)).toEqual([conversationId]);

      const reply = await replyConversationResponse(
        database.sql,
        session(recipient),
        conversationId,
        postRequest({ bodyMd: "A new reply." }),
      );
      expect(reply.status).toBe(200);

      lists = await listConversations(database.sql, starter);
      expect(lists.archive.map((row) => row.id)).not.toContain(conversationId);
      expect(lists.inbox.find((row) => row.id === conversationId)?.unreadCount).toBe(1);

      const read = await readConversationResponse(database.sql, session(starter), conversationId);
      expect(read.status).toBe(200);

      lists = await listConversations(database.sql, starter);
      expect(lists.inbox.find((row) => row.id === conversationId)?.unreadCount).toBe(0);
      expect(
        (await readConversationForParticipant(database.sql, conversationId, starter))?.viewer
          .unreadCount,
      ).toBe(0);

      const unarchive = await archiveConversationResponse(
        database.sql,
        session(starter),
        conversationId,
        postRequest({ archived: false }),
      );
      expect(unarchive.status).toBe(200);
    });
  }, 30_000);

  test("archive and read refuse non-participants", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const outsider = await memberId(database, "new-member");
      const conversationId = await startFixture(database, { starter, recipients: [recipient] });

      for (const response of [
        await archiveConversationResponse(
          database.sql,
          session(outsider),
          conversationId,
          postRequest({ archived: true }),
        ),
        await readConversationResponse(database.sql, session(outsider), conversationId),
      ]) {
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ code: "not_found" });
      }
    });
  }, 30_000);
});

integrationDescribe("conversation search", () => {
  test("finds title and message matches only in the member's own conversations", async () => {
    await withSeededDb(async (database) => {
      const memberOne = await memberId(database, "member-1");
      const memberTwo = await memberId(database, "member-2");
      const other = await memberId(database, "member-es");

      const outcome = await startConversation(database.sql, {
        actorId: memberOne,
        title: "Zebra planning",
        bodyMd: "The password is flamingo.",
        recipientIds: [memberTwo],
      });

      if (!outcome.ok) {
        throw new Error("Could not create the search fixture");
      }

      const otherConversation = await startConversation(database.sql, {
        actorId: memberTwo,
        title: "Private unicorn",
        bodyMd: "The unicorn stays secret.",
        recipientIds: [other],
      });

      if (!otherConversation.ok) {
        throw new Error("Could not create the other fixture");
      }

      expect(
        (await searchConversations(database.sql, memberOne, "flamingo")).map((row) => row.id),
      ).toEqual([outcome.result.conversationId]);
      expect(
        (await searchConversations(database.sql, memberOne, "Zebra")).map((row) => row.id),
      ).toEqual([outcome.result.conversationId]);
      // The other conversation contains the word but member one is not a participant.
      expect(await searchConversations(database.sql, memberOne, "unicorn")).toEqual([]);
      expect(
        (await searchConversations(database.sql, memberTwo, "unicorn")).map((row) => row.id),
      ).toEqual([otherConversation.result.conversationId]);
      expect(await searchConversations(database.sql, memberOne, "   ")).toEqual([]);

      const translate = createServerT("en", { shipped: USER_CATALOGS });
      const page = await buildInboxPage({
        sql: database.sql,
        memberId: memberOne,
        locale: "en",
        translate,
        folder: "inbox",
        query: "unicorn",
      });
      expect(page.conversations).toEqual([]);
      expect(page.hasConversations).toBe(false);
    });
  }, 30_000);
});

interface RecordingStorage {
  readonly storage: StorageClient;
  readonly deleted: string[];
}

function recordingStorage(): RecordingStorage {
  const deleted: string[] = [];

  return {
    deleted,
    storage: {
      async put() {
        return 0;
      },
      async get() {
        return new Uint8Array();
      },
      async exists() {
        return false;
      },
      async stat() {
        return { size: 0, contentType: "application/octet-stream", etag: "" };
      },
      async delete(key: string) {
        deleted.push(key);
      },
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

async function createReadyAttachment(
  database: TestDatabase,
  memberId: string,
  sizeBytes = 120,
): Promise<{ readonly id: string; readonly storageKey: string }> {
  const storageKey = `att/${crypto.randomUUID()}`;
  const [row] = (await database.sql`
    INSERT INTO core.attachments (
      member_id, state, filename, declared_type, declared_bytes, quarantine_key,
      storage_key, size_bytes, sha256, verified_type
    )
    VALUES (
      ${memberId}, 'ready', 'secret.pdf', 'application/pdf', ${sizeBytes},
      ${`quarantine/${crypto.randomUUID()}`}, ${storageKey}, ${sizeBytes},
      ${"a".repeat(64)}, 'application/pdf'
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error("Could not create the attachment");
  }

  await refreshMemberStorage(database.sql, [memberId]);
  return { id: row.id, storageKey };
}

async function attachToMessage(
  database: TestDatabase,
  messageId: string,
  attachmentId: string,
): Promise<void> {
  await database.sql`
    INSERT INTO core.conversation_message_attachments (message_id, attachment_id)
    VALUES (${messageId}, ${attachmentId})
  `;
}

async function conversationMessageIds(
  database: TestDatabase,
  conversationId: string,
): Promise<readonly string[]> {
  const rows = (await database.sql`
    SELECT id::text AS id
    FROM core.conversation_messages
    WHERE conversation_id = ${conversationId}
    ORDER BY id
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

async function storageUsedBytes(database: TestDatabase, memberId: string): Promise<number> {
  const [row] = (await database.sql`
    SELECT used_bytes::text AS used_bytes
    FROM core.member_storage
    WHERE member_id = ${memberId}
  `) as Array<{ used_bytes: string }>;

  return Number(row?.used_bytes ?? "0");
}

integrationDescribe("permanent conversation removal", () => {
  test("deletes an empty conversation, its messages, attachments and objects", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const conversationId = await startFixture(database, { starter, recipients: [recipient] });
      const [messageId] = await conversationMessageIds(database, conversationId);
      const attachment = await createReadyAttachment(database, starter);
      await attachToMessage(database, messageId ?? "", attachment.id);
      expect(await storageUsedBytes(database, starter)).toBe(120);

      await leaveConversation(database.sql, { actorId: starter, conversationId });
      await leaveConversation(database.sql, { actorId: recipient, conversationId });

      const recording = recordingStorage();
      const result = await runConversationRemoval(database.sql, recording.storage);

      expect(result).toMatchObject({
        removed: 1,
        kept: 0,
        messagesDeleted: 1,
        attachmentsDeleted: 1,
      });
      expect(recording.deleted).toContain(attachment.storageKey);
      expect(recording.deleted).toContain(thumbnailKeyFor(attachment.storageKey));
      expect(await conversationCount(database)).toBe(0);
      expect(await storageUsedBytes(database, starter)).toBe(0);

      // A second sweep is a no-op.
      const again = await runConversationRemoval(database.sql, recording.storage);
      expect(again.removed).toBe(0);
    });
  }, 30_000);

  test("keeps only held messages and their attachments until the hold is released", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const conversationId = await startFixture(database, { starter, recipients: [recipient] });

      const reply = await replyToConversation(database.sql, {
        actorId: recipient,
        conversationId,
        bodyMd: "This message will be reported.",
      });

      if (!reply.ok) {
        throw new Error("Could not create the reply");
      }

      const [first, second] = await conversationMessageIds(database, conversationId);
      const unheld = await createReadyAttachment(database, starter, 100);
      const held = await createReadyAttachment(database, starter, 140);
      await attachToMessage(database, first ?? "", unheld.id);
      await attachToMessage(database, second ?? "", held.id);
      await database.sql`
        INSERT INTO core.conversation_message_holds (message_id, holder, ref)
        VALUES (${second}, 'report', '42')
      `;
      expect(await storageUsedBytes(database, starter)).toBe(240);

      await leaveConversation(database.sql, { actorId: starter, conversationId });
      await leaveConversation(database.sql, { actorId: recipient, conversationId });

      const recording = recordingStorage();
      const keptResult = await runConversationRemoval(database.sql, recording.storage);

      expect(keptResult).toMatchObject({
        removed: 0,
        kept: 1,
        messagesDeleted: 1,
        attachmentsDeleted: 1,
      });
      expect(await conversationCount(database)).toBe(1);
      expect(await conversationMessageIds(database, conversationId)).toEqual([second]);
      expect(recording.deleted).toContain(unheld.storageKey);
      expect(recording.deleted).not.toContain(held.storageKey);
      expect(await storageUsedBytes(database, starter)).toBe(140);

      const stillKept = await runConversationRemoval(database.sql, recording.storage);
      expect(stillKept.kept).toBe(1);
      expect(stillKept.messagesDeleted).toBe(0);

      await database.sql`
        DELETE FROM core.conversation_message_holds
        WHERE message_id = ${second} AND holder = 'report' AND ref = '42'
      `;
      const finished = await runConversationRemoval(database.sql, recording.storage);

      expect(finished).toMatchObject({ removed: 1, kept: 0, messagesDeleted: 1 });
      expect(await conversationCount(database)).toBe(0);
      expect(recording.deleted).toContain(held.storageKey);
      expect(await storageUsedBytes(database, starter)).toBe(0);
    });
  }, 30_000);

  test("registers the removal sweep schedule", async () => {
    await withSeededDb(async (database) => {
      const calls: string[] = [];
      const boss = {
        getQueue: async () => ({}),
        updateQueue: async () => {},
        createQueue: async (name: string) => {
          calls.push(`create:${name}`);
        },
        work: async (name: string) => {
          calls.push(`work:${name}`);
        },
        schedule: async (name: string, cron: string) => {
          calls.push(`schedule:${name}:${cron}`);
        },
        offWork: async (name: string) => {
          calls.push(`off:${name}`);
        },
      } as unknown as PgBoss;

      const jobs = await createConversationJobs({
        boss,
        sql: database.sql,
        storage: recordingStorage().storage,
      });

      expect(calls).toContain(`work:${CONVERSATION_REMOVAL_QUEUE}`);
      expect(calls).toContain(
        `schedule:${CONVERSATION_REMOVAL_QUEUE}:${CONVERSATION_REMOVAL_CRON}`,
      );
      await jobs.stop();
      expect(calls).toContain(`off:${CONVERSATION_REMOVAL_QUEUE}`);
    });
  }, 30_000);
});
