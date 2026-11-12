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
import { replyToConversation, startConversation } from "@bulletin/domain/conversations";
import { createServerT } from "@bulletin/i18n";
import { type StorageClient, thumbnailKeyFor } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import {
  attachmentDownloadCountResponse,
  attachmentRequestResponse,
} from "../../apps/user-api/src/attachments.ts";
import { attachmentDownloadResponse } from "../../apps/user-app/src/attachments/download.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { buildConversationPage } from "../../apps/user-app/src/conversations/page.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

function storageStub(): StorageClient {
  return {
    async put() {
      return 0;
    },
    async get() {
      return new Uint8Array();
    },
    async exists() {
      return true;
    },
    async stat() {
      return { size: 0, contentType: "application/octet-stream", etag: "" };
    },
    async delete() {},
    async copy() {},
    async list() {
      return [];
    },
    presignGet(key: string) {
      return `https://files.example/${key}`;
    },
    presignPut(key: string) {
      return `https://files.example/${key}`;
    },
  };
}

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "conversation_attachments" }, async (database) => {
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

function session(memberIdValue: string): {
  readonly memberId: string;
  readonly sessionId: string;
} {
  return { memberId: memberIdValue, sessionId: "0" };
}

/** A second pool that connects as the role user-api uses in production. */
async function withRole(
  database: TestDatabase,
  role: string,
  run: (sql: SQL) => Promise<void>,
): Promise<void> {
  const url = new URL(database.url);
  url.username = role;
  url.password = "";
  const sql = new SQL(url.toString());

  try {
    await run(sql);
  } finally {
    await sql.close();
  }
}

function uploadRequest(body: unknown): Request {
  return new Request("http://bulletin.localhost/api/attachments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function startFixture(database: TestDatabase, starter: string, recipient: string) {
  const outcome = await startConversation(database.sql, {
    actorId: starter,
    title: "Attachment conversation",
    bodyMd: "First message.",
    recipientIds: [recipient],
  });

  if (!outcome.ok) {
    throw new Error(`Could not start the conversation: ${outcome.code}`);
  }

  return outcome.result.conversationId;
}

async function createReadyAttachment(
  database: TestDatabase,
  memberIdValue: string,
): Promise<{ readonly id: string; readonly storageKey: string }> {
  const storageKey = `att/${crypto.randomUUID()}`;
  const [row] = (await database.sql`
    INSERT INTO core.attachments (
      member_id, state, filename, declared_type, declared_bytes, quarantine_key,
      storage_key, size_bytes, sha256, verified_type
    )
    VALUES (
      ${memberIdValue}, 'ready', 'notes.pdf', 'application/pdf', 120,
      ${`quarantine/${crypto.randomUUID()}`}, ${storageKey}, 120,
      ${"a".repeat(64)}, 'application/pdf'
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error("Could not create the attachment");
  }

  return { id: row.id, storageKey };
}

integrationDescribe("conversation attachments", () => {
  test("an active participant may upload in a conversation; outsiders and former participants may not", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const outsider = await memberId(database, "new-member");
      const conversationId = await startFixture(database, starter, recipient);
      const storage = storageStub();

      const allowed = await attachmentRequestResponse(
        database.sql,
        storage,
        session(starter),
        uploadRequest({
          conversationId,
          filename: "notes.txt",
          contentType: "text/plain",
          sizeBytes: 10,
        }),
      );
      expect(allowed.status).toBe(201);
      expect(await allowed.json()).toMatchObject({ state: "pending", filename: "notes.txt" });

      const denied = await attachmentRequestResponse(
        database.sql,
        storage,
        session(outsider),
        uploadRequest({
          conversationId,
          filename: "notes.txt",
          contentType: "text/plain",
          sizeBytes: 10,
        }),
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ code: "forbidden" });

      // A former participant loses the upload context with the conversation access.
      await database.sql`
        UPDATE core.conversation_participants
        SET state = 'left', left_at = now()
        WHERE conversation_id = ${conversationId} AND member_id = ${recipient}
      `;
      const leftDenied = await attachmentRequestResponse(
        database.sql,
        storage,
        session(recipient),
        uploadRequest({
          conversationId,
          filename: "notes.txt",
          contentType: "text/plain",
          sizeBytes: 10,
        }),
      );
      expect(leftDenied.status).toBe(403);

      const noContext = await attachmentRequestResponse(
        database.sql,
        storage,
        session(starter),
        uploadRequest({
          filename: "notes.txt",
          contentType: "text/plain",
          sizeBytes: 10,
        }),
      );
      expect(noContext.status).toBe(400);
    });
  }, 30_000);

  test("links a reply attachment and authorises downloads by current participation", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const outsider = await memberId(database, "member-es");
      const conversationId = await startFixture(database, starter, recipient);
      const attachment = await createReadyAttachment(database, recipient);
      const storage = storageStub();

      const reply = await replyToConversation(database.sql, {
        actorId: recipient,
        conversationId,
        bodyMd: `See [notes](attachment:${attachment.id}).`,
      });
      expect(reply.ok).toBe(true);

      const [link] = (await database.sql`
        SELECT message_id::text AS message_id, attachment_id::text AS attachment_id
        FROM core.conversation_message_attachments
        WHERE attachment_id = ${attachment.id}
      `) as Array<{ message_id: string; attachment_id: string }>;
      expect(link).toBeDefined();

      const page = await buildConversationPage({
        sql: database.sql,
        memberId: starter,
        locale: "en",
        translate: createServerT("en", { shipped: USER_CATALOGS }),
        conversationId,
        attachmentsEnabled: true,
      });
      const files = page?.messages[1]?.files ?? null;
      expect(files).not.toBeNull();
      expect(String(files)).toContain("data-message-attachments");
      expect(String(files)).toContain("notes.pdf");

      const participantDownload = await attachmentDownloadResponse({
        sql: database.sql,
        storage,
        session: { memberId: starter, sessionId: "0" },
        hasSessionCookie: true,
        id: attachment.id,
      });
      expect(participantDownload.status).toBe(302);
      expect(participantDownload.headers.get("location")).toContain(attachment.storageKey);

      const outsiderDownload = await attachmentDownloadResponse({
        sql: database.sql,
        storage,
        session: { memberId: outsider, sessionId: "0" },
        hasSessionCookie: true,
        id: attachment.id,
      });
      expect(outsiderDownload.status).toBe(403);

      const counted = await attachmentDownloadCountResponse(
        database.sql,
        session(starter),
        attachment.id,
      );
      expect(counted.status).toBe(200);
      expect(await counted.json()).toEqual({ downloadCount: 1 });

      const countedDenied = await attachmentDownloadCountResponse(
        database.sql,
        session(outsider),
        attachment.id,
      );
      expect(countedDenied.status).toBe(403);

      // Leaving ends the download grant immediately.
      await database.sql`
        UPDATE core.conversation_participants
        SET state = 'left', left_at = now()
        WHERE conversation_id = ${conversationId} AND member_id = ${starter}
      `;
      const afterLeaving = await attachmentDownloadResponse({
        sql: database.sql,
        storage,
        session: { memberId: starter, sessionId: "0" },
        hasSessionCookie: true,
        id: attachment.id,
      });
      expect(afterLeaving.status).toBe(403);

      // The thumbnail preview path is also participant-only.
      const previewDenied = await attachmentDownloadResponse({
        sql: database.sql,
        storage,
        session: { memberId: outsider, sessionId: "0" },
        hasSessionCookie: true,
        id: attachment.id,
        preview: true,
      });
      expect(previewDenied.status).toBe(403);
      expect(thumbnailKeyFor(attachment.storageKey)).toContain("thumb");
    });
  }, 30_000);

  test("a reply with an attachment succeeds under the user_api role", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const conversationId = await startFixture(database, starter, recipient);
      const attachment = await createReadyAttachment(database, recipient);

      await withRole(database, "user_api", async (sql) => {
        const [identity] = (await sql`SELECT current_user AS role`) as Array<{ role: string }>;
        expect(identity?.role).toBe("user_api");

        // Linking the upload upserts with `ON CONFLICT DO UPDATE`, which Postgres refuses
        // without UPDATE even when no row conflicts (review finding P2).
        const reply = await replyToConversation(sql, {
          actorId: recipient,
          conversationId,
          bodyMd: `See [notes](attachment:${attachment.id}).`,
        });
        expect(reply.ok).toBe(true);
      });

      const [link] = (await database.sql`
        SELECT message_id::text AS message_id,
               attachment_id::text AS attachment_id,
               position
        FROM core.conversation_message_attachments
        WHERE attachment_id = ${attachment.id}
      `) as Array<{ message_id: string; attachment_id: string; position: number }>;
      expect(link).toMatchObject({ attachment_id: attachment.id, position: 0 });
    });
  }, 30_000);
});
