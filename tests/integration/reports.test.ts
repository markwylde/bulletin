import { describe, expect, test } from "bun:test";
import { runConversationRemoval } from "@bulletin/db/jobs";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import { refreshMemberStorage } from "@bulletin/domain/attachments";
import {
  leaveConversation,
  replyToConversation,
  startConversation,
} from "@bulletin/domain/conversations";
import { loadEvent } from "@bulletin/domain/events";
import { moderatedForums } from "@bulletin/domain/moderation";
import { can, loadForumTree } from "@bulletin/domain/permissions";
import {
  createReport,
  listReports,
  readReportDetail,
  updateReport,
} from "@bulletin/domain/reports";
import { startTopic } from "@bulletin/domain/topics";
import { type StorageClient, thumbnailKeyFor } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { createNotificationsEventHandler } from "../../apps/workers/src/notifications.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "reports" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        flagsSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
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

async function readableStartableForum(
  database: TestDatabase,
  member: string,
  moderator: string,
): Promise<string> {
  const tree = await loadForumTree(database.sql);
  const moderated = new Set(
    (await moderatedForums(database.sql, moderator, null, tree)).map((f) => f.id),
  );
  const rows = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE type = 'forum' ORDER BY id
  `) as Array<{ id: string }>;

  for (const row of rows) {
    if (
      moderated.has(row.id) &&
      (await can(database.sql, member, "read", { forumId: row.id, tree })) &&
      (await can(database.sql, member, "start", { forumId: row.id, tree }))
    ) {
      return row.id;
    }
  }

  throw new Error("Missing a forum both member and moderator can use");
}

async function unmoderatedStartableForum(
  database: TestDatabase,
  member: string,
  moderator: string,
): Promise<string> {
  const tree = await loadForumTree(database.sql);
  const moderated = new Set(
    (await moderatedForums(database.sql, moderator, null, tree)).map((f) => f.id),
  );
  const rows = (await database.sql`
    SELECT id::text AS id FROM core.forums WHERE type = 'forum' ORDER BY id
  `) as Array<{ id: string }>;

  for (const row of rows) {
    if (
      !moderated.has(row.id) &&
      (await can(database.sql, member, "read", { forumId: row.id, tree })) &&
      (await can(database.sql, member, "start", { forumId: row.id, tree }))
    ) {
      return row.id;
    }
  }

  throw new Error("Missing an unmoderated forum");
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

function recordingStorage(): { readonly deleted: string[]; readonly storage: StorageClient } {
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
    } as StorageClient,
  };
}

async function createReadyAttachment(
  database: TestDatabase,
  owner: string,
  sizeBytes: number,
): Promise<{ readonly id: string; readonly storageKey: string }> {
  const storageKey = `att/${crypto.randomUUID()}`;
  const [row] = (await database.sql`
    INSERT INTO core.attachments (
      member_id, state, filename, declared_type, declared_bytes, quarantine_key,
      storage_key, size_bytes, sha256, verified_type
    )
    VALUES (
      ${owner}, 'ready', 'report.pdf', 'application/pdf', ${sizeBytes},
      ${`quarantine/${crypto.randomUUID()}`}, ${storageKey}, ${sizeBytes},
      ${"a".repeat(64)}, 'application/pdf'
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error("Could not create the attachment");
  }

  await refreshMemberStorage(database.sql, [owner]);
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
    SELECT id::text AS id FROM core.conversation_messages
    WHERE conversation_id = ${conversationId}
    ORDER BY id
  `) as Array<{ id: string }>;

  return rows.map((row) => row.id);
}

async function notifications(database: TestDatabase) {
  return (await database.sql`
    SELECT member_id::text AS member_id, type
    FROM core.notifications ORDER BY id
  `) as Array<{ member_id: string; type: string }>;
}

integrationDescribe("reports", () => {
  test("groups reporters for the same post and prevents a duplicate open report", async () => {
    await withSeededDb(async (database) => {
      const author = await memberId(database, "member-1");
      const reporterA = await memberId(database, "member-2");
      const reporterB = await memberId(database, "member-fr");
      const forumMod = await memberId(database, "forum-mod");
      const forum = await readableStartableForum(database, author, forumMod);
      const topic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: forum,
          title: "Reported post",
          bodyMd: "This post will be reported.",
        }),
      );

      const first = expectOk(
        await createReport(database.sql, {
          actorId: reporterA,
          targetType: "post",
          targetId: topic.postId,
          reason: "spam",
          comment: "Looks like spam.",
        }),
      );
      const second = expectOk(
        await createReport(database.sql, {
          actorId: reporterB,
          targetType: "post",
          targetId: topic.postId,
          reason: "abuse",
          comment: "",
        }),
      );
      expect(second.reportId).toBe(first.reportId);

      expect(
        await createReport(database.sql, {
          actorId: reporterA,
          targetType: "post",
          targetId: topic.postId,
          reason: "spam",
          comment: "Again",
        }),
      ).toEqual({ ok: false, code: "already_reported" });

      expectOk(
        await updateReport(database.sql, {
          actorId: forumMod,
          reportId: first.reportId,
          action: { kind: "assign", assign: true },
        }),
      );
      expectOk(
        await updateReport(database.sql, {
          actorId: forumMod,
          reportId: first.reportId,
          action: { kind: "comment", body: "Looking into this now." },
        }),
      );
      const detail = expectOk(
        await readReportDetail(database.sql, { actorId: forumMod, reportId: first.reportId }),
      );
      expect(detail.assigneeId).toBe(forumMod);
      expect(detail.comments.map((comment) => comment.body)).toEqual(["Looking into this now."]);

      const page = await listReports(database.sql, { actorId: forumMod, limit: 10, offset: 0 });
      expect(page.total).toBe(1);
      expect(page.reports[0]?.reporters).toHaveLength(2);
      expect(page.reports[0]?.reporters.map((reporter) => reporter.reason)).toEqual([
        "spam",
        "abuse",
      ]);
      expect(page.reports[0]?.subject.label).toBe("Reported post");

      const otherForum = await unmoderatedStartableForum(database, author, forumMod);
      const otherTopic = expectOk(
        await startTopic(database.sql, {
          actorId: author,
          forumId: otherForum,
          title: "Out of scope",
          bodyMd: "Not this moderator's forum.",
        }),
      );
      expectOk(
        await createReport(database.sql, {
          actorId: reporterA,
          targetType: "post",
          targetId: otherTopic.postId,
          reason: "other",
          comment: "Elsewhere",
        }),
      );
      const scoped = await listReports(database.sql, { actorId: forumMod, limit: 10, offset: 0 });
      expect(scoped.total).toBe(1);
      expect(scoped.reports[0]?.targetId).toBe(topic.postId);
      expect(
        await listReports(database.sql, { actorId: author, limit: 10, offset: 0 }),
      ).toMatchObject({ total: 0, reports: [] });

      const privateForum = (await database.sql`
        SELECT id::text AS id FROM core.forums WHERE slug = 'staff-room'
      `) as Array<{ id: string }>;
      const hiddenTopic = expectOk(
        await startTopic(database.sql, {
          actorId: await memberId(database, "super-mod"),
          forumId: privateForum[0]?.id ?? forum,
          title: "Private report target",
          bodyMd: "Staff only.",
        }),
      );
      expect(
        await createReport(database.sql, {
          actorId: reporterA,
          targetType: "post",
          targetId: hiddenTopic.postId,
          reason: "spam",
          comment: "",
        }),
      ).toEqual({ ok: false, code: "not_found" });
    });
  }, 60_000);

  test("scopes member and PM reports by report permissions and audits PM context", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const forumMod = await memberId(database, "forum-mod");
      const superMod = await memberId(database, "super-mod");

      const memberReport = expectOk(
        await createReport(database.sql, {
          actorId: member,
          targetType: "member",
          targetId: recipient,
          reason: "harassment",
          comment: "Please look at this profile.",
        }),
      );
      const forumModPage = await listReports(database.sql, {
        actorId: forumMod,
        limit: 10,
        offset: 0,
      });
      expect(forumModPage.total).toBe(0);
      expect(
        await readReportDetail(database.sql, {
          actorId: forumMod,
          reportId: memberReport.reportId,
        }),
      ).toEqual({ ok: false, code: "forbidden" });

      const started = expectOk(
        await startConversation(database.sql, {
          actorId: member,
          title: "Private plan",
          bodyMd: "Message 1",
          recipientIds: [recipient],
        }),
      );
      const conversationId = started.conversationId;

      for (let index = 2; index <= 8; index += 1) {
        expectOk(
          await replyToConversation(database.sql, {
            actorId: recipient,
            conversationId,
            bodyMd: `Message ${index}`,
          }),
        );
      }

      const messageIds = await conversationMessageIds(database, conversationId);
      const reportedMessage = messageIds[6];

      if (reportedMessage === undefined) {
        throw new Error("Missing the reported message");
      }

      const pmReport = expectOk(
        await createReport(database.sql, {
          actorId: member,
          targetType: "pm",
          targetId: reportedMessage,
          reason: "abuse",
          comment: "This private message crossed a line.",
        }),
      );

      const holds = (await database.sql`
        SELECT count(*)::int AS count FROM core.conversation_message_holds
        WHERE holder = 'report' AND ref = ${pmReport.reportId}
      `) as Array<{ count: number }>;
      expect(holds[0]?.count).toBe(6);

      const detail = expectOk(
        await readReportDetail(database.sql, {
          actorId: superMod,
          reportId: pmReport.reportId,
        }),
      );
      expect(detail.pmMessages).toHaveLength(6);
      expect(detail.pmMessages?.map((message) => message.messageId)).toEqual(
        messageIds.slice(1, 7),
      );
      expect(detail.pmMessages?.at(-1)).toMatchObject({ reported: true });
      expect(detail.pmMessages?.map((message) => message.bodyHtml).join(" ")).not.toContain(
        "Message 1",
      );

      const audits = (await database.sql`
        SELECT action, target_id::text AS target_id, summary
        FROM core.moderation_log
        WHERE action = 'report.pm_access'
      `) as Array<{ action: string; target_id: string; summary: unknown }>;
      expect(audits).toHaveLength(1);
      expect(audits[0]?.target_id).toBe(pmReport.reportId);

      expect(
        await readReportDetail(database.sql, {
          actorId: forumMod,
          reportId: pmReport.reportId,
        }),
      ).toEqual({ ok: false, code: "forbidden" });
      expect(
        await listReports(database.sql, { actorId: recipient, limit: 10, offset: 0 }),
      ).toMatchObject({ total: 0 });

      const superPage = await listReports(database.sql, {
        actorId: superMod,
        limit: 10,
        offset: 0,
      });
      expect(superPage.reports.map((report) => report.targetType).sort()).toEqual(["member", "pm"]);
    });
  }, 60_000);

  test("keeps held PM messages and attachments until the report closes", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const superMod = await memberId(database, "super-mod");

      const started = expectOk(
        await startConversation(database.sql, {
          actorId: starter,
          title: "Reported conversation",
          bodyMd: "First message.",
          recipientIds: [recipient],
        }),
      );
      const conversationId = started.conversationId;

      for (let index = 0; index < 6; index += 1) {
        expectOk(
          await replyToConversation(database.sql, {
            actorId: recipient,
            conversationId,
            bodyMd: `Context message ${index}`,
          }),
        );
      }

      const messageIds = await conversationMessageIds(database, conversationId);
      const reportedMessage = messageIds.at(-1);

      if (reportedMessage === undefined) {
        throw new Error("Missing the reported message");
      }

      const report = expectOk(
        await createReport(database.sql, {
          actorId: starter,
          targetType: "pm",
          targetId: reportedMessage,
          reason: "abuse",
          comment: "",
        }),
      );

      const unheld = await createReadyAttachment(database, starter, 100);
      const held = await createReadyAttachment(database, starter, 140);
      await attachToMessage(database, messageIds[0] ?? "", unheld.id);
      await attachToMessage(database, reportedMessage, held.id);

      expectOk(await leaveConversation(database.sql, { actorId: starter, conversationId }));
      expectOk(await leaveConversation(database.sql, { actorId: recipient, conversationId }));

      const recording = recordingStorage();
      const kept = await runConversationRemoval(database.sql, recording.storage);
      expect(kept.removed).toBe(0);
      expect(kept.kept).toBeGreaterThanOrEqual(1);
      expect(await conversationMessageIds(database, conversationId)).toContain(reportedMessage);
      expect(recording.deleted).toContain(unheld.storageKey);
      expect(recording.deleted).not.toContain(held.storageKey);

      expectOk(
        await updateReport(database.sql, {
          actorId: superMod,
          reportId: report.reportId,
          action: { kind: "status", status: "resolved" },
        }),
      );

      const finished = await runConversationRemoval(database.sql, recording.storage);
      expect(finished.removed).toBe(1);
      expect(recording.deleted).toContain(held.storageKey);
      expect(await conversationMessageIds(database, conversationId)).toEqual([]);
    });
  }, 90_000);

  test("notifies every reporter when a report is resolved or rejected", async () => {
    await withSeededDb(async (database) => {
      const reporterA = await memberId(database, "member-1");
      const reporterB = await memberId(database, "member-2");
      const target = await memberId(database, "member-fr");
      const superMod = await memberId(database, "super-mod");

      const report = expectOk(
        await createReport(database.sql, {
          actorId: reporterA,
          targetType: "member",
          targetId: target,
          reason: "spam",
          comment: "",
        }),
      );
      expectOk(
        await createReport(database.sql, {
          actorId: reporterB,
          targetType: "member",
          targetId: target,
          reason: "other",
          comment: "",
        }),
      );

      expectOk(
        await updateReport(database.sql, {
          actorId: superMod,
          reportId: report.reportId,
          action: { kind: "status", status: "resolved" },
        }),
      );

      const eventRows = (await database.sql`
        SELECT id FROM core.events WHERE type = 'report.resolved' ORDER BY id
      `) as Array<{ id: string | bigint }>;
      expect(eventRows).toHaveLength(2);

      const handler = createNotificationsEventHandler({ sql: database.sql });

      for (const row of eventRows) {
        const event = await loadEvent(database.sql, BigInt(row.id));
        expect(event).not.toBeNull();

        if (event !== null) {
          await handler(event);
        }
      }

      expect(await notifications(database)).toEqual([
        { member_id: reporterA, type: "report.resolved" },
        { member_id: reporterB, type: "report.resolved" },
      ]);

      const rejected = expectOk(
        await createReport(database.sql, {
          actorId: reporterA,
          targetType: "member",
          targetId: await memberId(database, "member-es"),
          reason: "other",
          comment: "",
        }),
      );
      expectOk(
        await updateReport(database.sql, {
          actorId: superMod,
          reportId: rejected.reportId,
          action: { kind: "status", status: "rejected" },
        }),
      );
      const rejectedEvents = (await database.sql`
        SELECT id FROM core.events WHERE type = 'report.rejected' ORDER BY id
      `) as Array<{ id: string | bigint }>;
      expect(rejectedEvents).toHaveLength(1);
      const rejectedEvent = await loadEvent(database.sql, BigInt(rejectedEvents[0]?.id ?? "0"));

      if (rejectedEvent !== null) {
        await handler(rejectedEvent);
      }

      expect(await notifications(database)).toContainEqual({
        member_id: reporterA,
        type: "report.rejected",
      });
    });
  }, 60_000);
});
