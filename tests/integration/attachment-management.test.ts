import { describe, expect, test } from "bun:test";
import {
  baseSeedModule,
  forumExtrasSeedModule,
  groupsSeedModule,
  membersSeedModule,
  moderatorAssignmentsSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
  themesSeedModule,
} from "@bulletin/db/seed";
import {
  deleteAttachment,
  listMemberAttachments,
  readAttachmentById,
} from "@bulletin/domain/attachments";
import { startTopic } from "@bulletin/domain/topics";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { attachmentDeleteResponse } from "../../apps/user-api/src/attachments.ts";
import { buildAttachmentsPage } from "../../apps/user-app/src/account/attachments.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "attachment_manage" }, async (database) => {
    await runSeeds({
      sql: database.sql,
      registry: new SeedRegistry([
        baseSeedModule,
        permissionFixtureSeedModule,
        groupsSeedModule,
        forumExtrasSeedModule,
        membersSeedModule,
        moderatorAssignmentsSeedModule,
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

async function createAttachment(
  database: TestDatabase,
  member: string,
  filename = "notes.pdf",
  sizeBytes = 2048,
): Promise<string> {
  const [row] = (await database.sql`
    INSERT INTO core.attachments (
      member_id, state, filename, declared_type, declared_bytes, quarantine_key,
      snapshot_key, storage_key, size_bytes, sha256, verified_type, download_count
    )
    VALUES (
      ${member}, 'ready', ${filename}, 'application/pdf', ${sizeBytes},
      ${`quarantine/${crypto.randomUUID()}`}, ${`processing/${crypto.randomUUID()}`},
      ${`att/${crypto.randomUUID()}`}, ${sizeBytes}, ${"a".repeat(64)},
      'application/pdf', 2
    )
    RETURNING id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error("Could not create the attachment");
  }

  return row.id;
}

function ok<T>(
  outcome:
    | { readonly ok: true; readonly result: T }
    | { readonly ok: false; readonly code: string },
): T {
  if (!outcome.ok) {
    throw new Error(`Expected success, received ${outcome.code}`);
  }

  return outcome.result;
}

function postWithAttachment(request: Request): Request {
  return request;
}

integrationDescribe("attachment management", () => {
  test("lists a member's attachments with quota usage and deletes them", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const member = await memberId(database, "member-1");
      const attachmentId = await createAttachment(database, member, "holiday.pdf", 2048);
      ok(
        await startTopic(database.sql, {
          actorId: member,
          forumId: offTopic,
          title: "Holiday photos",
          bodyMd: `[holiday.pdf](attachment:${attachmentId})`,
        }),
      );
      await database.sql`
        INSERT INTO core.member_storage (member_id, used_bytes)
        VALUES (${member}, ${2048})
        ON CONFLICT (member_id) DO UPDATE SET used_bytes = EXCLUDED.used_bytes
      `;

      const page = await buildAttachmentsPage({
        sql: database.sql,
        memberId: member,
        locale: "en",
        translate,
      });

      expect(page.viewModel.hasAttachments).toBe(true);
      expect(page.viewModel.attachments[0]).toMatchObject({
        filename: "holiday.pdf",
        href: `/attachments/${attachmentId}/holiday.pdf`,
      });
      expect(page.viewModel.attachments[0]?.meta).toContain("2 kB");
      expect(page.viewModel.attachments[0]?.meta).toContain("2 downloads");
      expect(page.viewModel.usageLabel).toContain("2 kB");
      expect(page.viewModel.usageLabel).toContain("50 MB");

      const deleted = await deleteAttachment(database.sql, {
        actorId: member,
        attachmentId,
      });

      expect(deleted.ok).toBe(true);
      expect(await readAttachmentById(database.sql, attachmentId)).toMatchObject({
        state: "ready",
      });
      expect(await listMemberAttachments(database.sql, member)).toHaveLength(0);

      const usage = (await database.sql`
        SELECT used_bytes::text AS used_bytes FROM core.member_storage WHERE member_id = ${member}
      `) as Array<{ used_bytes: string }>;
      expect(usage[0]?.used_bytes).toBe("0");
    });
  }, 30_000);

  test("a moderator may remove an attachment from a post without deleting the file", async () => {
    await withSeededDb(async (database) => {
      const offTopic = await forumId(database, "off-topic");
      const member = await memberId(database, "member-1");
      const moderator = await memberId(database, "super-mod");
      const stranger = await memberId(database, "member-2");
      const attachmentId = await createAttachment(database, member);
      const topic = ok(
        await startTopic(database.sql, {
          actorId: member,
          forumId: offTopic,
          title: "Moderated attachment",
          bodyMd: `[notes.pdf](attachment:${attachmentId})`,
        }),
      );

      const denied = await deleteAttachment(database.sql, {
        actorId: stranger,
        attachmentId,
        postId: topic.postId,
      });
      expect(denied).toEqual({ ok: false, code: "forbidden" });

      const endpointDenied = await attachmentDeleteResponse(
        database.sql,
        { memberId: stranger, sessionId: "0" },
        attachmentId,
        postWithAttachment(
          new Request("http://bulletin.localhost/api/attachments/x/delete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ postId: topic.postId }),
          }),
        ),
      );
      expect(endpointDenied.status).toBe(403);

      const removed = await deleteAttachment(database.sql, {
        actorId: moderator,
        attachmentId,
        postId: topic.postId,
      });
      expect(removed).toMatchObject({ ok: true, postIds: [topic.postId] });

      const links = (await database.sql`
        SELECT 1 FROM core.post_attachments WHERE attachment_id = ${attachmentId}
      `) as unknown[];
      expect(links).toHaveLength(0);
      expect((await readAttachmentById(database.sql, attachmentId))?.state).toBe("ready");
      expect(await listMemberAttachments(database.sql, member)).toHaveLength(1);
    });
  }, 30_000);

  test("the delete endpoint accepts the owner and rejects strangers", async () => {
    await withSeededDb(async (database) => {
      const member = await memberId(database, "member-1");
      const stranger = await memberId(database, "member-2");
      const attachmentId = await createAttachment(database, member, "owner-only.pdf");

      const denied = await attachmentDeleteResponse(
        database.sql,
        { memberId: stranger, sessionId: "0" },
        attachmentId,
        postWithAttachment(
          new Request("http://bulletin.localhost/api/attachments/x/delete", {
            method: "POST",
            body: "{}",
          }),
        ),
      );
      expect(denied.status).toBe(403);

      const accepted = await attachmentDeleteResponse(
        database.sql,
        { memberId: member, sessionId: "0" },
        attachmentId,
        postWithAttachment(
          new Request("http://bulletin.localhost/api/attachments/x/delete", {
            method: "POST",
            body: "{}",
          }),
        ),
      );
      expect(accepted.status).toBe(200);
      expect((await readAttachmentById(database.sql, attachmentId))?.state).toBe("ready");
    });
  }, 30_000);
});
