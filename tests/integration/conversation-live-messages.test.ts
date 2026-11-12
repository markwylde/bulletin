import { describe, expect, test } from "bun:test";
import { currentContentVersions } from "@bulletin/content";
import { conversationMessageRerenderSource, runContentRerenderJob } from "@bulletin/db/jobs";
import {
  baseSeedModule,
  flagsSeedModule,
  groupsSeedModule,
  membersSeedModule,
  permissionFixtureSeedModule,
  runSeeds,
  SeedRegistry,
} from "@bulletin/db/seed";
import {
  readConversationForParticipant,
  replyToConversation,
  startConversation,
} from "@bulletin/domain/conversations";
import { createServerT } from "@bulletin/i18n";
import { type TestDatabase, withTestDatabase } from "@bulletin/test-utils/database";
import { SQL } from "bun";
import { conversationResponse } from "../../apps/user-api/src/conversations.ts";
import { USER_CATALOGS } from "../../apps/user-app/src/catalogs.ts";
import { loadLiveConversationMessages } from "../../apps/user-app/src/conversations/live.ts";
import {
  buildConversationPage,
  buildInboxPage,
} from "../../apps/user-app/src/conversations/page.ts";

const adminUrl = Bun.env.TEST_DATABASE_URL;
const integrationDescribe = adminUrl === undefined ? describe.skip : describe;
const translate = createServerT("en", { shipped: USER_CATALOGS });

function roleUrl(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = "";
  return url.toString();
}

async function withSeededDb(run: (database: TestDatabase) => Promise<void>): Promise<void> {
  if (adminUrl === undefined) {
    throw new Error("TEST_DATABASE_URL is required");
  }

  await withTestDatabase({ adminUrl, prefix: "conversation_live" }, async (database) => {
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

async function startFixture(database: TestDatabase, starter: string, recipient: string) {
  const outcome = await startConversation(database.sql, {
    actorId: starter,
    title: "Live message fixture",
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
      ${memberIdValue}, 'ready', 'live-notes.txt', 'text/plain', 20,
      ${`quarantine/${crypto.randomUUID()}`}, ${storageKey}, 20,
      ${"a".repeat(64)}, 'text/plain'
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error("Could not create the attachment");
  }

  return { id: row.id, storageKey };
}

integrationDescribe("live conversation message rendering", () => {
  test("drains a backlog larger than one batch without skipping the last reply", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const conversationId = await startFixture(database, starter, recipient);
      const [first] = (await database.sql`
        SELECT id::text AS id FROM core.conversation_messages
        WHERE conversation_id = ${conversationId} ORDER BY id LIMIT 1
      `) as Array<{ id: string }>;

      for (let index = 0; index < 150; index += 1) {
        await database.sql`
          INSERT INTO core.conversation_messages (
            conversation_id, author_id, body_md, body_html, body_text, created_at
          )
          VALUES (
            ${conversationId}, ${recipient}, ${`Backlog ${index}`},
            ${`<p>Backlog ${index}</p>`}, ${`Backlog ${index}`},
            now() + ${index}::int * interval '1 second'
          )
        `;
      }

      let after = first?.id ?? "0";
      const ids: string[] = [];
      let batches = 0;

      for (; batches < 5; batches += 1) {
        const result = await loadLiveConversationMessages({
          sql: database.sql,
          conversationId,
          memberId: starter,
          after,
          locale: "en",
          translate,
          attachmentsEnabled: true,
          mentionsEnabled: true,
        });

        if (result === null) {
          throw new Error("The starter should be a participant");
        }

        ids.push(...result.messages.map((message) => message.id));
        after = result.messages[result.messages.length - 1]?.id ?? after;

        if (!result.hasMore) {
          break;
        }
      }

      expect(ids).toHaveLength(150);
      expect(after).toBe(ids[ids.length - 1] ?? "");
    });
  }, 30_000);

  test("renders stale HTML, quotes and attachments in live and SSR reads", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const conversationId = await startFixture(database, starter, recipient);
      const [first] = (await database.sql`
        SELECT id::text AS id FROM core.conversation_messages
        WHERE conversation_id = ${conversationId} ORDER BY id LIMIT 1
      `) as Array<{ id: string }>;
      const attachment = await createReadyAttachment(database, recipient);

      const reply = await replyToConversation(database.sql, {
        actorId: recipient,
        conversationId,
        bodyMd: `:::quote{source="message:${first?.id}"}\nquoted text\n:::\n\n[Live file](attachment:${attachment.id})`,
      });
      expect(reply.ok).toBe(true);

      const live = await loadLiveConversationMessages({
        sql: database.sql,
        conversationId,
        memberId: starter,
        after: first?.id ?? "0",
        locale: "en",
        translate,
        attachmentsEnabled: true,
        mentionsEnabled: true,
      });
      expect(live?.messages).toHaveLength(1);
      expect(live?.messages[0]?.bodyHtml).toContain("quote-body");
      expect(live?.messages[0]?.filesHtml).toContain("live-notes.txt");

      const page = await buildConversationPage({
        sql: database.sql,
        memberId: starter,
        locale: "en",
        translate,
        conversationId,
        attachmentsEnabled: true,
      });
      expect(String(page?.messages[1]?.body)).toContain("quote-body");
      expect(String(page?.messages[1]?.files)).toContain("live-notes.txt");

      const [stored] = (await database.sql`
        SELECT id::text AS id FROM core.conversation_messages
        WHERE conversation_id = ${conversationId}
        ORDER BY id DESC LIMIT 1
      `) as Array<{ id: string }>;
      await database.sql`
        UPDATE core.conversation_messages
        SET body_html = '<p>safe</p><script>alert(1)</script>',
            body_text = 'safe',
            render_version = 1,
            sanitiser_version = 1
        WHERE id = ${stored?.id}
      `;

      const stale = await loadLiveConversationMessages({
        sql: database.sql,
        conversationId,
        memberId: starter,
        after: first?.id ?? "0",
        locale: "en",
        translate,
        attachmentsEnabled: true,
        mentionsEnabled: true,
      });
      expect(stale?.messages[0]?.bodyHtml).not.toContain("<script");
      expect(stale?.messages[0]?.bodyHtml).toContain("safe");

      const stalePage = await buildConversationPage({
        sql: database.sql,
        memberId: starter,
        locale: "en",
        translate,
        conversationId,
        attachmentsEnabled: true,
      });
      expect(String(stalePage?.messages[1]?.body)).not.toContain("<script");
      expect(String(stalePage?.messages[1]?.body)).toContain("safe");

      const api = await conversationResponse(database.sql, { memberId: starter }, conversationId);
      const apiBody = (await api.json()) as {
        messages: Array<{ bodyHtml: string }>;
      };
      expect(apiBody.messages[1]?.bodyHtml).not.toContain("<script");
      expect(apiBody.messages[1]?.bodyHtml).toContain("safe");

      const versions = currentContentVersions();
      const rerendered = await runContentRerenderJob(database.sql, {
        sources: [conversationMessageRerenderSource],
      });
      expect(rerendered.rerendered).toBeGreaterThan(0);
      const [saved] = (await database.sql`
        SELECT body_html, render_version, sanitiser_version
        FROM core.conversation_messages WHERE id = ${stored?.id}
      `) as Array<{ body_html: string; render_version: number; sanitiser_version: number }>;
      expect(saved?.body_html).not.toContain("<script");
      expect(saved?.render_version).toBe(versions.renderVersion);
      expect(saved?.sanitiser_version).toBe(versions.sanitiserVersion);

      expect(
        (await readConversationForParticipant(database.sql, conversationId, starter))?.messages,
      ).toHaveLength(2);
    });
  }, 30_000);

  test("the re-render worker can sanitise a stale message under the workers role", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const conversationId = await startFixture(database, starter, recipient);
      const [message] = (await database.sql`
        SELECT id::text AS id FROM core.conversation_messages
        WHERE conversation_id = ${conversationId} ORDER BY id LIMIT 1
      `) as Array<{ id: string }>;
      await database.sql`
        UPDATE core.conversation_messages
        SET body_md = '**worker bold**',
            body_html = '<p>old html</p><script>alert(1)</script>',
            body_text = 'worker bold',
            render_version = 1,
            sanitiser_version = 1
        WHERE id = ${message?.id}
      `;

      const worker = new SQL(roleUrl(database.url, "workers"));

      try {
        const result = await runContentRerenderJob(worker, {
          sources: [conversationMessageRerenderSource],
        });
        expect(result.rerendered).toBe(1);
      } finally {
        await worker.close();
      }

      const [saved] = (await database.sql`
        SELECT body_html, render_version FROM core.conversation_messages
        WHERE id = ${message?.id}
      `) as Array<{ body_html: string; render_version: number }>;
      expect(saved?.body_html).not.toContain("<script");
      expect(saved?.body_html).toContain("<strong>worker bold</strong>");
      expect(saved?.render_version).toBe(currentContentVersions().renderVersion);
    });
  }, 30_000);

  test("both conversation editors use the viewer's mentions flag", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const conversationId = await startFixture(database, starter, recipient);

      const detail = await buildConversationPage({
        sql: database.sql,
        memberId: starter,
        locale: "en",
        translate,
        conversationId,
        mentionsEnabled: false,
      });
      const inbox = await buildInboxPage({
        sql: database.sql,
        memberId: starter,
        locale: "en",
        translate,
        folder: "inbox",
        mentionsEnabled: false,
      });

      expect(detail?.editor?.flags.mentions).toBe(false);
      expect(inbox.editor?.flags.mentions).toBe(false);
    });
  }, 30_000);

  test("the worker preserves an already-authorised quote reference", async () => {
    await withSeededDb(async (database) => {
      const starter = await memberId(database, "member-1");
      const recipient = await memberId(database, "member-2");
      const conversationId = await startFixture(database, starter, recipient);
      const [first] = (await database.sql`
        SELECT id::text AS id FROM core.conversation_messages
        WHERE conversation_id = ${conversationId} ORDER BY id LIMIT 1
      `) as Array<{ id: string }>;
      const reply = await replyToConversation(database.sql, {
        actorId: recipient,
        conversationId,
        bodyMd: `:::quote{source="message:${first?.id}"}\nquoted text\n:::\n\nReply with quote.`,
      });
      expect(reply.ok).toBe(true);

      const [message] = (await database.sql`
        SELECT id::text AS id FROM core.conversation_messages
        WHERE conversation_id = ${conversationId} ORDER BY id DESC LIMIT 1
      `) as Array<{ id: string }>;
      await database.sql`
        UPDATE core.conversation_messages
        SET body_html = '<p>old quote html</p>', render_version = 1, sanitiser_version = 1
        WHERE id = ${message?.id}
      `;
      const [before] = (await database.sql`
        SELECT count(*)::int AS count FROM core.quote_snapshots
        WHERE source_kind = 'message' AND source_id = ${first?.id}
      `) as Array<{ count: number }>;

      const worker = new SQL(roleUrl(database.url, "workers"));

      try {
        await runContentRerenderJob(worker, {
          sources: [conversationMessageRerenderSource],
        });
      } finally {
        await worker.close();
      }

      const [saved] = (await database.sql`
        SELECT body_html FROM core.conversation_messages WHERE id = ${message?.id}
      `) as Array<{ body_html: string }>;
      expect(saved?.body_html).toContain('data-source-kind="message"');
      expect(saved?.body_html).not.toContain("quoted text");
      const [after] = (await database.sql`
        SELECT count(*)::int AS count FROM core.quote_snapshots
        WHERE source_kind = 'message' AND source_id = ${first?.id}
      `) as Array<{ count: number }>;
      expect(after?.count).toBe(before?.count);
    });
  }, 30_000);
});
