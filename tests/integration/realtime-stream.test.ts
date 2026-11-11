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
import type { SessionRecord } from "@bulletin/domain/auth";
import {
  leaveConversation,
  replyToConversation,
  startConversation,
} from "@bulletin/domain/conversations";
import { emit } from "@bulletin/domain/events";
import { createNotification } from "@bulletin/domain/notifications";
import { reply, startTopic } from "@bulletin/domain/topics";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { notificationReadResponse } from "../../apps/user-api/src/notifications.ts";
import { streamResponse } from "../../apps/user-api/src/stream.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

interface SseEvent {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
  readonly comment?: string;
}

class StreamReader {
  private buffer = "";

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async next(timeoutMs = 2_000): Promise<SseEvent | null> {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const boundary = this.buffer.indexOf("\n\n");

      if (boundary !== -1) {
        const block = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);

        if (block.trim() === "" || block.startsWith(":")) {
          return { comment: block.trim() };
        }

        const event: { id?: string; event?: string; data?: string } = {};

        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) {
            event.id = line.slice(4);
          } else if (line.startsWith("event: ")) {
            event.event = line.slice(7);
          } else if (line.startsWith("data: ")) {
            event.data = line.slice(6);
          }
        }

        return event;
      }

      const remaining = deadline - Date.now();

      if (remaining <= 0) {
        return null;
      }

      const chunk = await Promise.race([this.reader.read(), Bun.sleep(remaining).then(() => null)]);

      if (chunk === null || chunk.done) {
        return null;
      }

      this.buffer += new TextDecoder().decode(chunk.value);
    }
  }

  async event(name: string, timeoutMs = 3_000): Promise<SseEvent | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const event = await this.next(deadline - Date.now());

      if (event === null) {
        return null;
      }

      if (event.event === name) {
        return event;
      }
    }

    return null;
  }
}

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "realtime" }, async (database) => {
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

async function createSession(
  database: TestDatabase,
  memberIdValue: string,
  reauthAt: Date = new Date(Date.now() + 24 * 60 * 60 * 1_000),
): Promise<{ id: string; record: SessionRecord }> {
  const [row] = (await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (${memberIdValue}, 'user', decode(md5(random()::text), 'hex'), ${reauthAt})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error("Could not create session");
  }

  return {
    id: row.id,
    record: {
      id: row.id,
      memberId: memberIdValue,
      kind: "user",
      displayName: null,
      createdAt: new Date(),
      lastSeenAt: new Date(),
      reauthAt,
      lastAuthAt: new Date(),
      reauthRetryCount: 0,
      revokedAt: null,
      rotatePending: false,
      viaPreviousToken: false,
      previousTokenExpiresAt: null,
    },
  };
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

async function openStream(
  database: TestDatabase,
  session: SessionRecord,
  query: string,
  options: {
    readonly lastEventId?: string;
    readonly heartbeatMs?: number;
    readonly revalidateMs?: number;
    readonly reconcileMs?: number;
  } = {},
): Promise<{ response: Response; reader: StreamReader }> {
  const headers = new Headers();

  if (options.lastEventId !== undefined) {
    headers.set("last-event-id", options.lastEventId);
  }

  const response = await streamResponse({
    sql: database.sql,
    session,
    request: new Request(`http://user.test/api/stream${query}`, { headers }),
    heartbeatMs: options.heartbeatMs ?? 20,
    revalidateMs: options.revalidateMs ?? 60_000,
    reconcileMs: options.reconcileMs ?? 60_000,
  });

  if (response.body === null) {
    throw new Error("Stream response has no body");
  }

  return { response, reader: new StreamReader(response.body.getReader()) };
}

async function notifyMember(database: TestDatabase, member: string): Promise<bigint> {
  const eventId = await database.sql.begin(async (tx) =>
    emit(tx, {
      type: "member.promoted",
      aggregateId: BigInt(member),
      aggregateVersion: 1n,
      payloadIds: { memberId: BigInt(member), fromGroupId: 1n, toGroupId: 2n, ruleId: 3n },
    }),
  );
  const notificationId = await createNotification(database.sql, {
    memberId: member,
    type: "member.promoted",
    eventId,
  });

  if (notificationId === null) {
    throw new Error("Notification was deduplicated");
  }

  return notificationId;
}

integrationDescribe("realtime stream", () => {
  test("sends the current count and wakes on a notification", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const { record } = await createSession(database, member);
      const { response, reader } = await openStream(database, record, "");

      try {
        expect(response.status).toBe(200);
        const initial = await reader.event("notifications");
        expect(initial?.data).toBe(JSON.stringify({ count: 0 }));
        expect(initial?.id).toMatch(/^n:\d+\|t:\d+$/);

        await notifyMember(database, member);
        const update = await reader.event("notifications");
        expect(update?.data).toBe(JSON.stringify({ count: 1 }));
      } finally {
        await reader.next(50).catch(() => null);
        await response.body?.cancel().catch(() => undefined);
      }
    });
  }, 30_000);

  test("announces new replies in the subscribed topic", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-2");
      const member = await memberId(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: offTopic,
          title: "Realtime topic",
          bodyMd: "Body.",
        }),
      );
      const { record } = await createSession(database, member);
      const { response, reader } = await openStream(
        database,
        record,
        `?topic=${topic.topicId}&post=${topic.postId}`,
      );

      try {
        await reader.event("notifications");
        const post = expectOk(
          await reply(database.sql, {
            actorId: author,
            topicId: topic.topicId,
            bodyMd: "A fresh reply.",
          }),
        );
        const update = await reader.event("new_replies");
        expect(JSON.parse(update?.data ?? "{}")).toMatchObject({
          topicId: topic.topicId,
          count: 1,
          postId: post.postId,
        });
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    });
  }, 30_000);

  test("cannot subscribe to a topic the viewer cannot read", async () => {
    await withSeededDb(async (database) => {
      const staffRoom = await forumId(database, "staff-room");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: admin,
          forumId: staffRoom,
          title: "Hidden realtime topic",
          bodyMd: "Body.",
        }),
      );
      const { record } = await createSession(database, member);
      const response = await streamResponse({
        sql: database.sql,
        session: record,
        request: new Request(
          `http://user.test/api/stream?topic=${topic.topicId}&post=${topic.postId}`,
        ),
      });

      expect(response.status).toBe(404);
    });
  }, 30_000);

  test("replays the gap after a short disconnect", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-2");
      const member = await memberId(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: offTopic,
          title: "Replay topic",
          bodyMd: "Body.",
        }),
      );
      const post = expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: "Missed reply.",
        }),
      );
      await notifyMember(database, member);

      const { record } = await createSession(database, member);
      const { response, reader } = await openStream(database, record, `?topic=${topic.topicId}`, {
        lastEventId: `n:0|t:${topic.postId}`,
      });

      try {
        const replies = await reader.event("new_replies");
        expect(JSON.parse(replies?.data ?? "{}")).toMatchObject({
          topicId: topic.topicId,
          postId: post.postId,
        });
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    });
  }, 30_000);

  test("instructs a resync when the gap is older than the replay window", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const oldId = await notifyMember(database, member);
      await notifyMember(database, member);
      // The missed event itself is older than the one-hour replay window.
      await database.sql`
        UPDATE core.notifications
        SET created_at = now() - interval '2 hours'
        WHERE member_id = ${member}
      `;

      const { record } = await createSession(database, member);
      const { response, reader } = await openStream(database, record, "", {
        lastEventId: `n:${oldId}|t:0`,
      });

      try {
        const first = await reader.next(3_000);
        expect(first?.event).toBe("resync");
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    });
  }, 30_000);

  test("sends session_revoked and closes when the session is revoked", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const { id, record } = await createSession(database, member);
      const { response, reader } = await openStream(database, record, "");

      try {
        await reader.event("notifications");
        await database.sql`UPDATE core.sessions SET revoked_at = now() WHERE id = ${id}`;
        await database.sql`SELECT pg_notify('session_revoked', ${member})`;

        expect((await reader.event("session_revoked"))?.event).toBe("session_revoked");
        expect(await reader.next(500)).toBeNull();
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    });
  }, 30_000);

  test("refuses a session past its re-auth grace and closes an open one", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const stale = await createSession(
        database,
        member,
        new Date(Date.now() - 3 * 60 * 60 * 1_000),
      );
      const refused = await streamResponse({
        sql: database.sql,
        session: stale.record,
        request: new Request("http://user.test/api/stream"),
      });
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ code: "reauth_required" });

      const { id, record } = await createSession(database, member);
      const { response, reader } = await openStream(database, record, "", {
        revalidateMs: 50,
      });

      try {
        await reader.event("notifications");
        await database.sql`
          UPDATE core.sessions SET reauth_at = now() - interval '3 hours' WHERE id = ${id}
        `;
        expect((await reader.event("reauth_required", 2_000))?.event).toBe("reauth_required");
        expect(await reader.next(500)).toBeNull();
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    });
  }, 30_000);

  test("an unlocked password forum streams and stops when the grant is revoked", async () => {
    await withSeededDb(async (database) => {
      const locked = await forumId(database, "general-discussion");
      const admin = await memberId(database, "admin");
      const member = await memberId(database, "member-1");
      const [adminSession] = (await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (${admin}, 'user', decode(md5(random()::text), 'hex'), now() + interval '1 day')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;

      if (adminSession === undefined) {
        throw new Error("Missing admin session");
      }

      await database.sql`
        INSERT INTO core.session_grants (session_id, kind, resource_id)
        VALUES (${adminSession.id}, 'forum_password', ${locked})
      `;
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: admin,
          forumId: locked,
          sessionId: adminSession.id,
          title: "Locked forum topic",
          bodyMd: "Body.",
        }),
      );

      const { id, record } = await createSession(database, member);

      // The connection itself is only allowed by a grant, not by the session row.
      const unlocked = await database.sql`
        INSERT INTO core.session_grants (session_id, kind, resource_id)
        VALUES (${id}, 'forum_password', ${locked})
        ON CONFLICT DO NOTHING
        RETURNING 1
      `;
      expect(unlocked).toHaveLength(1);

      const opened = await streamResponse({
        sql: database.sql,
        session: record,
        request: new Request(
          `http://user.test/api/stream?topic=${topic.topicId}&post=${topic.postId}`,
        ),
      });
      expect(opened.status).toBe(200);
      await opened.body?.cancel().catch(() => undefined);

      await database.sql`
        DELETE FROM core.session_grants
        WHERE session_id = ${id} AND kind = 'forum_password' AND resource_id = ${locked}
      `;
      const refused = await streamResponse({
        sql: database.sql,
        session: record,
        request: new Request(
          `http://user.test/api/stream?topic=${topic.topicId}&post=${topic.postId}`,
        ),
      });
      expect(refused.status).toBe(404);
    });
  }, 30_000);

  test("reconciles a dropped wake-up, the initial gap and a cross-tab mark-read", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-2");
      const member = await memberId(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: offTopic,
          title: "Reconcile topic",
          bodyMd: "Body.",
        }),
      );
      const { record } = await createSession(database, member);
      const { response, reader } = await openStream(
        database,
        record,
        `?topic=${topic.topicId}&post=${topic.postId}`,
        { reconcileMs: 100 },
      );

      try {
        await reader.event("notifications");

        // Neither a NOTIFY nor a normal publish path is used here.
        await database.sql`
          INSERT INTO core.posts (
            topic_id, author_id, body_md, body_html, body_text, render_version,
            sanitiser_version, position
          ) VALUES (
            ${topic.topicId}, ${author}, 'Missed wake-up.', '<p>Missed wake-up.</p>',
            'Missed wake-up.', 1, 1,
            (SELECT COALESCE(MAX(position), 0) + 1 FROM core.posts WHERE topic_id = ${topic.topicId})
          )
        `;
        await database.sql`
          INSERT INTO core.notifications (member_id, type, count)
          VALUES (${member}, 'member.promoted', 1)
        `;

        let sawReplies = false;
        let sawCount = false;

        for (let attempt = 0; attempt < 10 && !(sawReplies && sawCount); attempt += 1) {
          const event = await reader.next(1_000);

          if (event?.event === "new_replies") {
            sawReplies = true;
          } else if (event?.event === "notifications") {
            sawCount = JSON.parse(event.data ?? "{}").count === 1 || sawCount;
          }
        }

        expect({ sawReplies, sawCount }).toEqual({ sawReplies: true, sawCount: true });

        const marked = await notificationReadResponse(
          database.sql,
          member,
          new Request("http://user.test/api/notifications/read", {
            method: "POST",
            body: JSON.stringify({ all: true }),
          }),
        );
        expect(marked.status).toBe(200);
        const cleared = await reader.event("notifications");
        expect(JSON.parse(cleared?.data ?? "{}")).toMatchObject({ count: 0 });
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    });
  }, 30_000);

  test("catches up a reply posted before the stream opened", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const author = await memberId(database, "member-2");
      const member = await memberId(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: offTopic,
          title: "Initial gap topic",
          bodyMd: "Body.",
        }),
      );
      // The page rendered the first post; a reply lands before the stream connects.
      const post = expectOk(
        await reply(database.sql, {
          actorId: author,
          topicId: topic.topicId,
          bodyMd: "Reply before connect.",
        }),
      );
      const { record } = await createSession(database, member);
      const { response, reader } = await openStream(
        database,
        record,
        `?topic=${topic.topicId}&post=${topic.postId}`,
      );

      try {
        const update = await reader.event("new_replies");
        expect(JSON.parse(update?.data ?? "{}")).toMatchObject({
          topicId: topic.topicId,
          postId: post.postId,
        });
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    });
  }, 30_000);

  test("a topic moved into a hidden forum stops sending replies", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const staffRoom = await forumId(database, "staff-room");
      const author = await memberId(database, "member-2");
      const member = await memberId(database, "member-1");
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: offTopic,
          title: "Moved topic",
          bodyMd: "Body.",
        }),
      );
      const { record } = await createSession(database, member);
      const { response, reader } = await openStream(
        database,
        record,
        `?topic=${topic.topicId}&post=${topic.postId}`,
        { reconcileMs: 100 },
      );

      try {
        await reader.event("notifications");
        await database.sql`
          UPDATE core.topics SET forum_id = ${staffRoom} WHERE id = ${topic.topicId}
        `;
        await database.sql`
          INSERT INTO core.posts (
            topic_id, author_id, body_md, body_html, body_text, render_version,
            sanitiser_version, position
          ) VALUES (
            ${topic.topicId}, ${author}, 'Hidden reply.', '<p>Hidden reply.</p>',
            'Hidden reply.', 1, 1,
            (SELECT COALESCE(MAX(position), 0) + 1 FROM core.posts WHERE topic_id = ${topic.topicId})
          )
        `;

        let sawReplies = false;

        for (let attempt = 0; attempt < 5; attempt += 1) {
          const event = await reader.next(200);

          if (event?.event === "new_replies") {
            sawReplies = true;
          }
        }

        expect(sawReplies).toBe(false);
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    });
  }, 30_000);

  test("streams a live conversation reply only to current participants", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const outsider = await memberId(database, "member-es");
      const started = await startConversation(database.sql, {
        actorId: starter,
        title: "Live conversation",
        bodyMd: "First message.",
        recipientIds: [recipient],
      });

      if (!started.ok) {
        throw new Error("Could not start the conversation");
      }

      const [{ id: firstMessage }] = (await database.sql`
        SELECT id::text AS id FROM core.conversation_messages
        WHERE conversation_id = ${started.result.conversationId}
        ORDER BY id LIMIT 1
      `) as Array<{ id: string }>;

      const { record } = await createSession(database, starter);
      const { response, reader } = await openStream(
        database,
        record,
        `?conversation=${started.result.conversationId}&message=${firstMessage}`,
        { reconcileMs: 100 },
      );

      try {
        await reader.event("notifications");
        const reply = await replyToConversation(database.sql, {
          actorId: recipient,
          conversationId: started.result.conversationId,
          bodyMd: "Live reply.",
        });
        expect(reply.ok).toBe(true);

        const event = await reader.event("conversation_replies", 5_000);
        expect(event?.data).toBeDefined();
        const payload = JSON.parse(event?.data ?? "{}") as {
          readonly conversationId: string;
          readonly messageId: string;
          readonly count: number;
        };
        expect(payload.conversationId).toBe(started.result.conversationId);
        expect(payload.count).toBeGreaterThan(0);

        // Once the viewer leaves, the same stream must stop delivering messages.
        await leaveConversation(database.sql, {
          actorId: starter,
          conversationId: started.result.conversationId,
        });
        const afterLeaving = await replyToConversation(database.sql, {
          actorId: recipient,
          conversationId: started.result.conversationId,
          bodyMd: "Hidden after leaving.",
        });
        expect(afterLeaving.ok).toBe(true);

        let leaked = false;

        for (let attempt = 0; attempt < 6; attempt += 1) {
          const next = await reader.next(250);

          if (next?.event === "conversation_replies") {
            leaked = true;
          }
        }

        expect(leaked).toBe(false);
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }

      // A non-participant cannot open the conversation stream at all.
      const outsiderSession = await createSession(database, outsider);
      const denied = await openStream(
        database,
        outsiderSession.record,
        `?conversation=${started.result.conversationId}`,
      );
      expect(denied.response.status).toBe(404);
      await denied.response.body?.cancel().catch(() => undefined);
    });
  }, 30_000);

  test("sends heartbeats on an idle stream", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const { record } = await createSession(database, member);
      const { response, reader } = await openStream(database, record, "", { heartbeatMs: 20 });

      try {
        await reader.event("notifications");
        let heartbeat: SseEvent | null = null;

        for (let attempt = 0; attempt < 5; attempt += 1) {
          heartbeat = await reader.next(1_000);

          if (heartbeat?.comment !== undefined) {
            break;
          }
        }

        expect(heartbeat?.comment).toBe(": heartbeat");
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    });
  }, 30_000);
});
