import { renderContent } from "@bulletin/content";
import {
  refreshMemberStorage,
  syncConversationMessageAttachments,
} from "@bulletin/domain/attachments";
import { readMemberSearchConfig } from "@bulletin/domain/conversations";
import { attachmentKey, processingKey, quarantineKey, type StorageClient } from "@bulletin/storage";
import type { SQL } from "bun";
import type { SeedModule } from "./framework.ts";

interface SeedParticipant {
  readonly sub: string;
  readonly folder?: "inbox" | "archive";
  readonly state?: "active" | "left";
  readonly blockReinvite?: boolean;
  /** How much of the seeded history the member has read. */
  readonly read?: "all" | "first" | "none";
}

interface SeedMessage {
  readonly author: string;
  readonly bodyMd: string;
  readonly attachment?: {
    readonly filename: string;
    readonly body: string;
  };
}

interface SeedConversation {
  readonly title: string;
  /** Hours before the seed run, so the inbox order is stable. */
  readonly hoursAgo: number;
  readonly starter: string;
  readonly participants: readonly SeedParticipant[];
  readonly messages: readonly SeedMessage[];
}

async function memberId(sql: SQL, sub: string): Promise<string> {
  const [row] = (await sql`
    SELECT member_id::text AS member_id FROM pii.identities WHERE sub = ${sub}
  `) as Array<{ member_id: string }>;

  if (row === undefined) {
    throw new Error(`Missing seed member ${sub}`);
  }

  return row.member_id;
}

/** A ready, object-backed text attachment owned by the message author. */
async function seedAttachment(
  sql: SQL,
  storage: StorageClient | undefined,
  ownerId: string,
  filename: string,
  body: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const storageKey = attachmentKey(crypto.randomUUID());

  if (storage !== undefined) {
    await storage.put(storageKey, bytes, { contentType: "text/plain" });
  }

  const [row] = (await sql`
    INSERT INTO core.attachments (
      member_id, state, filename, declared_type, declared_bytes, quarantine_key,
      snapshot_key, storage_key, size_bytes, sha256, verified_type, expires_at
    )
    VALUES (
      ${ownerId}, 'ready', ${filename}, 'text/plain', ${bytes.byteLength}, ${quarantineKey()},
      ${processingKey(crypto.randomUUID())}, ${storageKey}, ${bytes.byteLength},
      ${Bun.CryptoHasher.hash("sha256", bytes).toString("hex")}, 'text/plain', NULL
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Could not seed conversation attachment ${filename}`);
  }

  await refreshMemberStorage(sql, [ownerId]);
  return row.id;
}

async function seedConversation(
  sql: SQL,
  storage: StorageClient | undefined,
  conversation: SeedConversation,
): Promise<void> {
  const starterId = await memberId(sql, conversation.starter);
  const startedAt = new Date(Date.now() - conversation.hoursAgo * 60 * 60 * 1_000);
  const lang = await readMemberSearchConfig(sql, starterId);
  const [row] = (await sql`
    INSERT INTO core.conversations (title, starter_id, created_at, last_message_at, lang)
    VALUES (
      ${conversation.title}, ${starterId}, ${startedAt}, ${startedAt}, ${lang}::regconfig
    )
    RETURNING id::text AS id
  `) as Array<{ id: string }>;

  if (row === undefined) {
    throw new Error(`Could not seed conversation ${conversation.title}`);
  }

  const conversationId = row.id;

  for (const participant of conversation.participants) {
    const participantId = await memberId(sql, participant.sub);
    const state = participant.state ?? "active";

    await sql`
      INSERT INTO core.conversation_participants (
        conversation_id, member_id, state, joined_at, left_at, folder, block_reinvite
      )
      VALUES (
        ${conversationId},
        ${participantId},
        ${state},
        ${startedAt},
        ${state === "left" ? startedAt : null},
        ${participant.folder ?? "inbox"},
        ${participant.blockReinvite === true}
      )
    `;
  }

  const messageIds: string[] = [];
  let lastMessageAt = startedAt;

  for (const [index, message] of conversation.messages.entries()) {
    const authorId = await memberId(sql, message.author);
    const createdAt = new Date(startedAt.getTime() + index * 5 * 60 * 1_000);
    let bodyMd = message.bodyMd;

    if (message.attachment !== undefined) {
      const attachmentId = await seedAttachment(
        sql,
        storage,
        authorId,
        message.attachment.filename,
        message.attachment.body,
      );
      bodyMd = bodyMd.replace(
        "{{attachment}}",
        `[${message.attachment.filename}](attachment:${attachmentId})`,
      );
    }

    const rendered = await renderContent(bodyMd, {
      profile: "post",
      context: { kind: "conversation_message", conversationId },
      authorId,
    });
    const [inserted] = (await sql`
      INSERT INTO core.conversation_messages (
        conversation_id, author_id, body_md, body_html, body_text, created_at, lang
      )
      VALUES (
        ${conversationId}, ${authorId}, ${rendered.bodyMd}, ${rendered.bodyHtml},
        ${rendered.bodyText}, ${createdAt}, ${await readMemberSearchConfig(sql, authorId)}::regconfig
      )
      RETURNING id::text AS id
    `) as Array<{ id: string }>;

    if (inserted === undefined) {
      throw new Error(`Could not seed a message in ${conversation.title}`);
    }

    messageIds.push(inserted.id);
    lastMessageAt = createdAt;
    await syncConversationMessageAttachments(sql, {
      messageId: inserted.id,
      conversationId,
      authorId,
      bodyHtml: rendered.bodyHtml,
    });
  }

  await sql`
    UPDATE core.conversations
    SET last_message_at = ${lastMessageAt}
    WHERE id = ${conversationId}
  `;

  for (const participant of conversation.participants) {
    const participantId = await memberId(sql, participant.sub);
    const read = participant.read ?? "all";
    const lastRead =
      read === "none"
        ? null
        : read === "first"
          ? (messageIds[0] ?? null)
          : (messageIds[messageIds.length - 1] ?? null);

    await sql`
      UPDATE core.conversation_participants
      SET last_read_message_id = ${lastRead}
      WHERE conversation_id = ${conversationId} AND member_id = ${participantId}
    `;
  }
}

/**
 * Seeded conversations for every local profile's inbox (task 4.2): a 1:1 thread with a file,
 * a group thread, an archived thread, and a thread whose other participant left.
 */
export const conversationSeedModule: SeedModule = {
  name: "conversations",
  dependsOn: ["base", "groups", "members"],
  async run({ sql, storage }) {
    const conversations: readonly SeedConversation[] = [
      {
        title: "Weekend plans",
        hoursAgo: 2,
        starter: "member-1",
        participants: [
          { sub: "member-1", read: "first" },
          { sub: "member-2", read: "all" },
        ],
        messages: [
          { author: "member-1", bodyMd: "Are we still on for the weekend?" },
          {
            author: "member-2",
            bodyMd: "Yes — I booked the table. Details are attached.\n\n{{attachment}}",
            attachment: {
              filename: "booking-confirmation.txt",
              body: "Table for two, Saturday at 19:00.\n",
            },
          },
        ],
      },
      {
        title: "Photo walk",
        hoursAgo: 8,
        starter: "member-1",
        participants: [
          { sub: "member-1", read: "all" },
          { sub: "member-es", read: "all" },
          { sub: "member-fr", read: "first" },
        ],
        messages: [
          { author: "member-1", bodyMd: "Anyone up for a photo walk on Saturday?" },
          { author: "member-es", bodyMd: "Count me in — I will bring the wide lens." },
          { author: "member-fr", bodyMd: "Same here, if the weather holds." },
        ],
      },
      {
        title: "Old chat",
        hoursAgo: 30,
        starter: "member-2",
        participants: [
          { sub: "member-2", read: "all" },
          { sub: "member-1", folder: "archive", read: "all" },
        ],
        messages: [
          { author: "member-2", bodyMd: "This conversation is getting long." },
          { author: "member-1", bodyMd: "Moving it to the archive for now." },
        ],
      },
      {
        title: "A member left",
        hoursAgo: 54,
        starter: "member-1",
        participants: [
          { sub: "member-1", read: "all" },
          { sub: "member-2", state: "left", blockReinvite: true, read: "first" },
        ],
        messages: [
          { author: "member-1", bodyMd: "First message before they left." },
          { author: "member-2", bodyMd: "I am leaving this conversation." },
        ],
      },
    ];

    for (const conversation of conversations) {
      await seedConversation(sql, storage, conversation);
    }
  },
};
