import { describe, expect, test } from "bun:test";
import { runExportJob, runRetention } from "@bulletin/db/jobs";
import { sessionCookieName } from "@bulletin/domain/auth";
import { notificationDeliveryContext } from "@bulletin/domain/notifications";
import { createServerT } from "@bulletin/i18n";
import { PRESIGN_GET_EXPIRES_IN, type StorageClient } from "@bulletin/storage";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { strFromU8, unzipSync } from "fflate";
import {
  dataExportDownloadResponse,
  requestDataExportResponse,
} from "../../apps/user-api/src/data-export.ts";
import { buildNotificationsPage } from "../../apps/user-app/src/account/notifications.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { createCoreEventHandler } from "../../apps/workers/src/core-events.ts";
import { buildNotificationEmail as buildEmail } from "../../apps/workers/src/email.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;

async function withDb(
  prefix: string,
  run: (database: TestDatabase) => Promise<void>,
): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix }, run);
}

interface RecordingStorage {
  readonly storage: StorageClient;
  readonly objects: Map<string, Uint8Array>;
  readonly deleted: string[];
}

function createStorage(attachmentKey: string, attachmentBytes: Uint8Array): RecordingStorage {
  const objects = new Map<string, Uint8Array>([[attachmentKey, attachmentBytes]]);
  const deleted: string[] = [];

  return {
    objects,
    deleted,
    storage: {
      async put(key, data) {
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
        objects.set(key, bytes);
        return bytes.byteLength;
      },
      async get(key) {
        return objects.get(key) ?? new Uint8Array();
      },
      async exists(key) {
        return objects.has(key);
      },
      async stat() {
        return { size: 0, contentType: "application/octet-stream", etag: "" };
      },
      async delete(key) {
        deleted.push(key);
        objects.delete(key);
      },
      async copy(source, destination) {
        const bytes = objects.get(source);
        if (bytes !== undefined) {
          objects.set(destination, bytes);
        }
      },
      async list() {
        return [];
      },
      presignGet(key, options) {
        return `https://files.test/${key}?expires=${options?.expiresIn ?? 60}`;
      },
      presignPut() {
        return "https://files.test/upload";
      },
    },
  };
}

interface ExportFixtures {
  readonly memberId: string;
  readonly token: string;
  readonly conversationId: string;
  readonly attachmentKey: string;
  readonly attachmentBytes: Uint8Array;
}

async function createFixtures(database: TestDatabase): Promise<ExportFixtures> {
  const [member] = (await database.sql`
    INSERT INTO core.members (display_name, locale, about_md)
    VALUES ('Export Member', 'en', 'About the exporting member.')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const [other] = (await database.sql`
    INSERT INTO core.members (display_name) VALUES ('Other Member') RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (member === undefined || other === undefined) {
    throw new Error("Could not create export members");
  }

  await database.sql`
    INSERT INTO pii.identities (member_id, issuer, sub, email)
    VALUES (${member.id}, 'https://auth.test', 'export-member', 'export@example.test')
  `;
  const token = "export-session-token";
  await database.sql`
    INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
    VALUES (${member.id}, 'user', sha256(convert_to(${token}, 'UTF8')), now() + interval '1 day')
  `;
  const [forum] = (await database.sql`
    INSERT INTO core.forums (type, title, slug) VALUES ('forum', 'Export Forum', 'export-forum')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const [topic] = (await database.sql`
    INSERT INTO core.topics (forum_id, title, slug, starter_id)
    VALUES (${forum?.id}, 'Export topic', 'export-topic', ${member.id})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;
  const [post] = (await database.sql`
    INSERT INTO core.posts (
      topic_id, author_id, body_md, body_html, body_text, render_version,
      sanitiser_version, position
    )
    VALUES (
      ${topic?.id}, ${member.id}, 'Exported body markdown', '<p>Exported body markdown</p>',
      'Exported body markdown', 1, 1, 1
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (topic === undefined || post === undefined) {
    throw new Error("Could not create export content");
  }

  await database.sql`
    INSERT INTO core.post_revisions (
      post_id, body_md, body_html, body_text, render_version, sanitiser_version,
      editor_id, edited_at
    )
    VALUES (
      ${post.id}, 'Old body markdown', '<p>Old body markdown</p>', 'Old body markdown',
      1, 1, ${member.id}, now() - interval '1 hour'
    )
  `;
  const [conversation] = (await database.sql`
    INSERT INTO core.conversations (title, starter_id)
    VALUES ('Export conversation', ${member.id})
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (conversation === undefined) {
    throw new Error("Could not create export conversation");
  }

  await database.sql`
    INSERT INTO core.conversation_participants (conversation_id, member_id)
    VALUES (${conversation.id}, ${member.id}), (${conversation.id}, ${other.id})
  `;
  await database.sql`
    INSERT INTO core.conversation_messages (conversation_id, author_id, body_md, body_html, body_text)
    VALUES (
      ${conversation.id}, ${member.id}, 'Conversation body',
      '<p>Conversation body</p>', 'Conversation body'
    )
  `;
  const [reaction] = (await database.sql`
    INSERT INTO core.reactions (key, icon, label_key)
    VALUES ('export_like', '👍', 'reaction.label.like')
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (reaction === undefined) {
    throw new Error("Could not create export reaction");
  }

  await database.sql`
    INSERT INTO core.post_reactions (post_id, member_id, reaction_id)
    VALUES (${post.id}, ${member.id}, ${reaction.id})
  `;
  await database.sql`
    INSERT INTO core.followed_topics (member_id, topic_id) VALUES (${member.id}, ${topic.id})
  `;
  await database.sql`
    INSERT INTO core.followed_forums (member_id, forum_id) VALUES (${member.id}, ${forum?.id})
  `;
  await database.sql`
    INSERT INTO core.followed_members (follower_id, followed_id) VALUES (${member.id}, ${other.id})
  `;
  const [reason] = (await database.sql`
    INSERT INTO core.warning_reasons (key, points, expiry_days)
    VALUES ('export_reason', 2, 30)
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (reason === undefined) {
    throw new Error("Could not create export warning reason");
  }

  await database.sql`
    INSERT INTO core.warning_reason_labels (reason_id, locale, label)
    VALUES (${reason.id}, 'en', 'Export warning')
  `;
  await database.sql`
    INSERT INTO core.warnings (
      member_id, reason_id, points, expires_at, member_note, staff_note
    )
    VALUES (
      ${member.id}, ${reason.id}, 2, now() + interval '30 days',
      'Member-visible note', 'Staff-only note'
    )
  `;
  const attachmentKey = "att/export-file";
  const attachmentBytes = new TextEncoder().encode("attachment bytes");
  await database.sql`
    INSERT INTO core.attachments (
      member_id, state, filename, declared_type, declared_bytes, quarantine_key,
      storage_key, size_bytes, sha256, verified_type
    )
    VALUES (
      ${member.id}, 'ready', 'export notes.txt', 'text/plain', ${attachmentBytes.byteLength},
      'quarantine/export', ${attachmentKey}, ${attachmentBytes.byteLength},
      ${"a".repeat(64)}, 'text/plain'
    )
  `;
  await database.sql`
    INSERT INTO core.plugin_personal_data (plugin_id, table_name, member_column)
    VALUES ('sample-plugin', 'sample_notes', 'member_id')
  `;

  return {
    memberId: member.id,
    token,
    conversationId: conversation.id,
    attachmentKey,
    attachmentBytes,
  };
}

integrationDescribe("member data export", () => {
  test("builds the archive, notifies the member and serves the expiring link", async () => {
    await withDb("privacy_export", async (database) => {
      const fixtures = await createFixtures(database);
      const storage = createStorage(fixtures.attachmentKey, fixtures.attachmentBytes);
      const cookie = `${sessionCookieName("user", "test")}=${fixtures.token}`;
      const requested = await requestDataExportResponse(
        database.sql,
        fixtures.memberId,
        new Request("http://bulletin.test/api/me/data-export", {
          method: "POST",
          headers: { cookie },
        }),
        "test",
      );
      expect(requested.status).toBe(202);
      const requestId = ((await requested.json()) as { requestId: string }).requestId;

      const emailIntents: string[] = [];
      const result = await runExportJob(database.sql, storage.storage, requestId, {
        pluginExport: async () => ({ ok: true, data: { notes: ["plugin note"] } }),
        enqueueEmail: async (intentId) => {
          emailIntents.push(intentId);
        },
      });

      expect(result).not.toBeNull();
      expect(result?.exportKey).toMatch(/^export\/[0-9a-f-]+\.zip$/);
      expect(result?.pluginFailures).toEqual([]);
      expect(emailIntents).toHaveLength(1);

      const archive = storage.objects.get(result?.exportKey ?? "");
      expect(archive).toBeDefined();

      if (archive === undefined) {
        throw new Error("export archive was not uploaded");
      }

      const files = unzipSync(archive);
      expect(Object.keys(files).sort()).toEqual(
        expect.arrayContaining([
          "attachments.json",
          "conversations.json",
          "follows.json",
          "manifest.json",
          "plugins/sample-plugin.json",
          "posts.json",
          "profile.json",
          "reactions.json",
          "restricted.json",
          "settings.json",
          "warnings.json",
        ]),
      );
      expect(strFromU8(files["profile.json"] ?? new Uint8Array())).toContain(
        "About the exporting member.",
      );
      expect(strFromU8(files["posts.json"] ?? new Uint8Array())).toContain(
        "Exported body markdown",
      );
      expect(strFromU8(files["conversations.json"] ?? new Uint8Array())).toContain(
        "Conversation body",
      );
      expect(strFromU8(files["restricted.json"] ?? new Uint8Array())).toContain(
        "export@example.test",
      );
      const warnings = strFromU8(files["warnings.json"] ?? new Uint8Array());
      expect(warnings).toContain("Member-visible note");
      expect(warnings).not.toContain("Staff-only note");
      expect(strFromU8(files["plugins/sample-plugin.json"] ?? new Uint8Array())).toContain(
        "plugin note",
      );
      expect(strFromU8(files["attachments.json"] ?? new Uint8Array())).toContain(
        "export notes.txt",
      );
      const attachmentFile = result?.files.find((name) => name.startsWith("attachments/"));
      expect(attachmentFile).toBeString();
      expect(files[attachmentFile ?? ""]).toEqual(fixtures.attachmentBytes);

      const [request] = (await database.sql`
        SELECT status, export_key, export_expires_at FROM pii.data_requests
        WHERE id = ${requestId}
      `) as Array<{ status: string; export_key: string; export_expires_at: Date }>;
      expect(request).toMatchObject({
        status: "completed",
        export_key: result?.exportKey,
      });
      expect(request?.export_expires_at.getTime()).toBeGreaterThan(Date.now());

      const [notification] = (await database.sql`
        SELECT id::text AS id, type, data_request_id::text AS data_request_id
        FROM core.notifications
        WHERE member_id = ${fixtures.memberId}
      `) as Array<{ id: string; type: string; data_request_id: string }>;
      expect(notification).toEqual({
        id: notification?.id,
        type: "data.export.ready",
        data_request_id: requestId,
      });

      const [intent] = (await database.sql`
        SELECT id::text AS id, channel, delivered_at
        FROM core.delivery_intents
        WHERE kind = 'notification' AND ref_id = ${notification?.id}
      `) as Array<{ id: string; channel: string; delivered_at: Date | null }>;
      expect(intent?.channel).toBe("email");
      expect(intent?.delivered_at).toBeNull();
      expect(emailIntents).toEqual([intent?.id]);

      const page = await buildNotificationsPage({
        sql: database.sql,
        memberId: fixtures.memberId,
        sessionId: null,
        locale: "en",
        translate: createServerT("en", { shipped: USER_CATALOGS }),
      });
      const inAppEntry = page.viewModel.sections
        .flatMap((section) => section.entries)
        .find((entry) => entry.text.includes("ready"));
      expect(inAppEntry?.href).toBe(`/api/me/data-export/${requestId}`);

      const context = await notificationDeliveryContext(database.sql, intent?.id ?? "");
      expect(context?.dataRequestId).toBe(requestId);

      if (context !== null) {
        const email = buildEmail({
          row: context,
          to: "export@example.test",
          options: {
            smtpUrl: "smtp://mail.test:1025",
            mailFrom: "Bulletin <no-reply@example.test>",
            userOrigin: "http://bulletin.test",
            unsubscribeSecret: "export-secret",
          },
        });
        expect(email.subject).toContain("ready");
        expect(email.text).toContain(`/api/me/data-export/${requestId}`);
      }

      const download = await dataExportDownloadResponse(
        database.sql,
        storage.storage,
        new Request("http://bulletin.test/api/me/data-export/1", {
          headers: { cookie },
        }),
        "test",
        requestId,
      );
      expect(download.status).toBe(303);
      expect(download.headers.get("location")).toContain(result?.exportKey ?? "");
      expect(download.headers.get("location")).toContain(`expires=${PRESIGN_GET_EXPIRES_IN}`);

      // After the retention window the link is refused and the object is gone.
      await database.sql`
        UPDATE pii.data_requests
        SET export_expires_at = now() - interval '1 day'
        WHERE id = ${requestId}
      `;
      await runRetention(database.sql, storage.storage);
      expect(storage.deleted).toContain(result?.exportKey ?? "");

      const expired = await dataExportDownloadResponse(
        database.sql,
        storage.storage,
        new Request("http://bulletin.test/api/me/data-export/1", {
          headers: { cookie },
        }),
        "test",
        requestId,
      );
      expect(expired.status).toBe(404);
    });
  }, 60_000);

  test("streams a large attachment set into the archive", async () => {
    await withDb("privacy_export_large", async (database) => {
      const fixtures = await createFixtures(database);
      const storage = createStorage(fixtures.attachmentKey, fixtures.attachmentBytes);
      const large = new Uint8Array(512 * 1_024).fill(65);

      for (let index = 0; index < 3; index += 1) {
        const key = `att/large-${index}`;
        storage.objects.set(key, large);
        await database.sql`
          INSERT INTO core.attachments (
            member_id, state, filename, declared_type, declared_bytes, quarantine_key,
            storage_key, size_bytes, sha256, verified_type
          ) VALUES (
            ${fixtures.memberId}, 'ready', ${`large-${index}.bin`}, 'application/octet-stream',
            ${large.byteLength}, ${`quarantine/large-${index}`}, ${key}, ${large.byteLength},
            ${"d".repeat(64)}, 'application/octet-stream'
          )
        `;
      }

      const cookie = `${sessionCookieName("user", "test")}=${fixtures.token}`;
      const requested = await requestDataExportResponse(
        database.sql,
        fixtures.memberId,
        new Request("http://bulletin.test/api/me/data-export", {
          method: "POST",
          headers: { cookie },
        }),
        "test",
      );
      const requestId = ((await requested.json()) as { requestId: string }).requestId;
      const result = await runExportJob(database.sql, storage.storage, requestId, {
        pluginExport: async () => ({ ok: true, data: {} }),
      });
      const archive = storage.objects.get(result?.exportKey ?? "");

      if (archive === undefined) {
        throw new Error("large export archive was not uploaded");
      }

      const files = unzipSync(archive);
      const attachmentFiles = Object.entries(files).filter(([name]) =>
        name.startsWith("attachments/"),
      );
      expect(attachmentFiles).toHaveLength(4);
      expect(
        attachmentFiles.filter(([, bytes]) => bytes.byteLength === large.byteLength),
      ).toHaveLength(3);
    });
  }, 60_000);

  test("recovers an export-ready email whose enqueue failed", async () => {
    await withDb("privacy_export_email_recovery", async (database) => {
      const fixtures = await createFixtures(database);
      const storage = createStorage(fixtures.attachmentKey, fixtures.attachmentBytes);
      const cookie = `${sessionCookieName("user", "test")}=${fixtures.token}`;
      const requested = await requestDataExportResponse(
        database.sql,
        fixtures.memberId,
        new Request("http://bulletin.test/api/me/data-export", {
          method: "POST",
          headers: { cookie },
        }),
        "test",
      );
      const requestId = ((await requested.json()) as { requestId: string }).requestId;

      await expect(
        runExportJob(database.sql, storage.storage, requestId, {
          pluginExport: async () => ({ ok: true, data: {} }),
          enqueueEmail: async () => {
            throw new Error("queue down");
          },
        }),
      ).rejects.toThrow(/queue down/);

      const [row] = (await database.sql`
        SELECT status FROM pii.data_requests WHERE id = ${requestId}
      `) as Array<{ status: string }>;
      expect(row?.status).toBe("completed");
      const [intent] = (await database.sql`
        SELECT i.id::text AS id FROM core.delivery_intents i
        JOIN core.notifications n ON n.id = i.ref_id
        WHERE n.data_request_id = ${requestId} AND i.delivered_at IS NULL
      `) as Array<{ id: string }>;
      expect(intent?.id).toBeString();

      const enqueued: string[] = [];
      const recovered = await runExportJob(database.sql, storage.storage, requestId, {
        pluginExport: async () => ({ ok: true, data: {} }),
        enqueueEmail: async (id) => {
          enqueued.push(id);
        },
      });
      expect(recovered).toBeNull();
      expect(enqueued).toEqual([intent?.id]);
    });
  }, 60_000);

  test("does not export a conversation after the member is removed", async () => {
    await withDb("privacy_export_removed", async (database) => {
      const fixtures = await createFixtures(database);
      const storage = createStorage(fixtures.attachmentKey, fixtures.attachmentBytes);
      await database.sql`
        UPDATE core.conversation_participants
        SET state = 'removed', left_at = now()
        WHERE conversation_id = ${fixtures.conversationId} AND member_id = ${fixtures.memberId}
      `;
      const cookie = `${sessionCookieName("user", "test")}=${fixtures.token}`;
      const requested = await requestDataExportResponse(
        database.sql,
        fixtures.memberId,
        new Request("http://bulletin.test/api/me/data-export", {
          method: "POST",
          headers: { cookie },
        }),
        "test",
      );
      const requestId = ((await requested.json()) as { requestId: string }).requestId;
      const result = await runExportJob(database.sql, storage.storage, requestId, {
        pluginExport: async () => ({ ok: true, data: {} }),
      });
      const archive = storage.objects.get(result?.exportKey ?? "");

      if (archive === undefined) {
        throw new Error("export archive was not uploaded");
      }

      const files = unzipSync(archive);
      const conversations = strFromU8(files["conversations.json"] ?? new Uint8Array());
      expect(conversations).not.toContain("Conversation body");
      expect(conversations).not.toContain("Export conversation");
    });
  }, 60_000);

  test("keeps an export open when a plugin hook fails", async () => {
    await withDb("privacy_export_plugin_failure", async (database) => {
      const fixtures = await createFixtures(database);
      const storage = createStorage(fixtures.attachmentKey, fixtures.attachmentBytes);
      const cookie = `${sessionCookieName("user", "test")}=${fixtures.token}`;
      const requested = await requestDataExportResponse(
        database.sql,
        fixtures.memberId,
        new Request("http://bulletin.test/api/me/data-export", {
          method: "POST",
          headers: { cookie },
        }),
        "test",
      );
      const requestId = ((await requested.json()) as { requestId: string }).requestId;

      await expect(
        runExportJob(database.sql, storage.storage, requestId, {
          pluginExport: async () => ({ ok: false, error: "plugin down" }),
        }),
      ).rejects.toThrow(/plugin down/);

      const [row] = (await database.sql`
        SELECT status, export_key, last_error FROM pii.data_requests WHERE id = ${requestId}
      `) as Array<{ status: string; export_key: string | null; last_error: string | null }>;
      expect(row).toMatchObject({ status: "processing", export_key: null });
      expect(row?.last_error).toContain("plugin down");
      const [notification] = (await database.sql`
        SELECT count(*)::int AS count FROM core.notifications
        WHERE data_request_id = ${requestId}
      `) as Array<{ count: number }>;
      expect(notification?.count).toBe(0);

      let attempts = 0;
      const retried = await runExportJob(database.sql, storage.storage, requestId, {
        pluginExport: async () => {
          attempts += 1;
          return attempts === 1
            ? { ok: false, error: "transient" }
            : { ok: true, data: { recovered: true } };
        },
      });
      expect(attempts).toBe(2);
      expect(retried?.exportKey).toMatch(/^export\//);
      const [completed] = (await database.sql`
        SELECT status, last_error FROM pii.data_requests WHERE id = ${requestId}
      `) as Array<{ status: string; last_error: string | null }>;
      expect(completed).toEqual({ status: "completed", last_error: null });
    });
  }, 60_000);

  test("refuses an unauthenticated or foreign download", async () => {
    await withDb("privacy_export_auth", async (database) => {
      const fixtures = await createFixtures(database);
      const storage = createStorage(fixtures.attachmentKey, fixtures.attachmentBytes);
      const requested = await requestDataExportResponse(
        database.sql,
        fixtures.memberId,
        new Request("http://bulletin.test/api/me/data-export", {
          method: "POST",
          headers: { cookie: `${sessionCookieName("user", "test")}=${fixtures.token}` },
        }),
        "test",
      );
      const requestId = ((await requested.json()) as { requestId: string }).requestId;

      await runExportJob(database.sql, storage.storage, requestId, {
        pluginExport: async () => ({ ok: true, data: {} }),
      });

      const unauthorised = await dataExportDownloadResponse(
        database.sql,
        storage.storage,
        new Request("http://bulletin.test/api/me/data-export/1"),
        "test",
        requestId,
      );
      expect(unauthorised.status).toBe(401);

      const [other] = (await database.sql`
        INSERT INTO core.members (display_name) VALUES ('Foreign Export Member')
        RETURNING id::text AS id
      `) as Array<{ id: string }>;
      const otherToken = "foreign-export-token";
      await database.sql`
        INSERT INTO core.sessions (member_id, kind, token_hash, reauth_at)
        VALUES (
          ${other?.id}, 'user', sha256(convert_to(${otherToken}, 'UTF8')),
          now() + interval '1 day'
        )
      `;
      const foreign = await dataExportDownloadResponse(
        database.sql,
        storage.storage,
        new Request("http://bulletin.test/api/me/data-export/1", {
          headers: { cookie: `${sessionCookieName("user", "test")}=${otherToken}` },
        }),
        "test",
        requestId,
      );
      expect(foreign.status).toBe(404);
    });
  }, 60_000);
});

integrationDescribe("export event fan-out", () => {
  test("the core subscriber queues an export request", async () => {
    await withDb("privacy_export_event", async (database) => {
      const queued: string[] = [];
      const handler = createCoreEventHandler({
        sql: database.sql,
        enqueueExport: async (requestId) => {
          queued.push(requestId);
        },
      });

      await handler({
        id: 1n,
        type: "privacy.export.requested",
        aggregateType: "data_request",
        aggregateId: 7n,
        aggregateVersion: 1n,
        payloadIds: { requestId: "7", memberId: "3" },
        createdAt: new Date(),
        publishedAt: null,
      });

      expect(queued).toEqual(["7"]);
    });
  }, 30_000);
});
