import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { readConversationForParticipant, startConversation } from "@bulletin/domain/conversations";
import { insertIgnore } from "@bulletin/domain/relationships";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import {
  conversationResponse,
  createConversationResponse,
} from "../../apps/user-api/src/conversations.ts";

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
