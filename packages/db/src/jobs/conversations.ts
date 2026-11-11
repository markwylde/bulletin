import type { Logger } from "@bulletin/config";
import { refreshMemberStorage } from "@bulletin/domain/attachments";
import {
  type AttachmentRecord,
  type AttachmentRow,
  attachmentFromRow,
  type StorageClient,
} from "@bulletin/storage";
import type { SQL } from "bun";
import type { PgBoss } from "pg-boss";
import { ensurePgBossQueue } from "../events/pg-boss.ts";
import { attachmentObjectKeys } from "./attachments.ts";

/** Every minute: finish removal once no participant remains and no hold keeps a message. */
export const CONVERSATION_REMOVAL_QUEUE = "conversation.removal";
export const CONVERSATION_REMOVAL_CRON = "* * * * *";

export interface ConversationRemovalOptions {
  readonly limit?: number;
  readonly logger?: Logger;
}

export interface ConversationRemovalResult {
  readonly removed: number;
  readonly kept: number;
  readonly messagesDeleted: number;
  readonly attachmentsDeleted: number;
  readonly objectsDeleted: number;
}

interface RemovalPlan {
  readonly removed: boolean;
  readonly keptMessages: number;
  readonly deletedMessages: number;
  readonly attachments: readonly AttachmentRecord[];
}

function bigintArray(ids: readonly string[]): string {
  return `{${ids.join(",")}}`;
}

/**
 * Removes one conversation that has no active participant. With no holds this deletes the
 * conversation row (messages and links cascade); with holds it keeps the row and only the held
 * messages, then a later run finishes removal after the last hold is released. The caller deletes
 * the returned object keys; a failed object delete is picked up by the reconciliation sweep.
 */
async function planRemoval(sql: SQL, conversationId: string): Promise<RemovalPlan | null> {
  return sql.begin(async (tx) => {
    const [candidate] = (await tx`
      SELECT c.id::text AS id
      FROM core.conversations c
      WHERE c.id = ${conversationId}
        AND NOT EXISTS (
          SELECT 1
          FROM core.conversation_participants p
          WHERE p.conversation_id = c.id AND p.state = 'active'
        )
      FOR UPDATE
    `) as Array<{ id: string }>;

    if (candidate === undefined) {
      return null;
    }

    const heldRows = (await tx`
      SELECT h.message_id::text AS id
      FROM core.conversation_message_holds h
      JOIN core.conversation_messages m ON m.id = h.message_id
      WHERE m.conversation_id = ${conversationId}
    `) as Array<{ id: string }>;
    const held = heldRows.map((row) => row.id);
    const attachmentRows =
      held.length === 0
        ? ((await tx`
            SELECT DISTINCT cma.attachment_id::text AS id
            FROM core.conversation_message_attachments cma
            JOIN core.conversation_messages m ON m.id = cma.message_id
            WHERE m.conversation_id = ${conversationId}
          `) as Array<{ id: string }>)
        : ((await tx`
            SELECT DISTINCT cma.attachment_id::text AS id
            FROM core.conversation_message_attachments cma
            JOIN core.conversation_messages m ON m.id = cma.message_id
            WHERE m.conversation_id = ${conversationId}
              AND NOT (m.id = ANY(${bigintArray(held)}::bigint[]))
          `) as Array<{ id: string }>);

    let deletedMessages = 0;

    if (held.length > 0) {
      const deleted = (await tx`
        DELETE FROM core.conversation_messages
        WHERE conversation_id = ${conversationId}
          AND NOT (id = ANY(${bigintArray(held)}::bigint[]))
        RETURNING id
      `) as unknown[];
      deletedMessages = deleted.length;

      await tx`
        UPDATE core.conversations
        SET last_message_at = COALESCE(
          (SELECT max(created_at) FROM core.conversation_messages WHERE conversation_id = ${conversationId}),
          last_message_at
        )
        WHERE id = ${conversationId}
      `;
    } else {
      const messageCounts = (await tx`
        SELECT count(*)::int AS count
        FROM core.conversation_messages
        WHERE conversation_id = ${conversationId}
      `) as Array<{ count: number }>;
      deletedMessages = messageCounts[0]?.count ?? 0;

      // Deleting the row cascades participants, messages, attachment links and any holds.
      await tx`DELETE FROM core.conversations WHERE id = ${conversationId}`;
    }

    const deletedAttachments =
      attachmentRows.length === 0
        ? []
        : ((await tx`
            DELETE FROM core.attachments a
            WHERE a.id = ANY(${bigintArray(attachmentRows.map((row) => row.id))}::bigint[])
              AND NOT EXISTS (
                SELECT 1 FROM core.post_attachments pa WHERE pa.attachment_id = a.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM core.conversation_message_attachments cma
                WHERE cma.attachment_id = a.id
              )
            RETURNING a.*
          `) as AttachmentRow[]);
    const attachments = deletedAttachments.map(attachmentFromRow);

    await refreshMemberStorage(
      tx,
      attachments.map((attachment) => attachment.memberId),
    );

    return {
      removed: held.length === 0,
      keptMessages: held.length,
      deletedMessages,
      attachments,
    };
  });
}

/**
 * Sweeps every conversation with no active participant. Idempotent: a conversation kept by a
 * hold is retried on every run, and finishes once the hold is gone.
 */
export async function runConversationRemoval(
  sql: SQL,
  storage: StorageClient,
  options: ConversationRemovalOptions = {},
): Promise<ConversationRemovalResult> {
  const candidates = (await sql`
    SELECT c.id::text AS id
    FROM core.conversations c
    WHERE NOT EXISTS (
      SELECT 1
      FROM core.conversation_participants p
      WHERE p.conversation_id = c.id AND p.state = 'active'
    )
    ORDER BY c.id
    LIMIT ${options.limit ?? 50}
  `) as Array<{ id: string }>;
  let removed = 0;
  let kept = 0;
  let messagesDeleted = 0;
  let attachmentsDeleted = 0;
  let objectsDeleted = 0;

  for (const row of candidates) {
    const plan = await planRemoval(sql, row.id);

    if (plan === null) {
      continue;
    }

    if (plan.removed) {
      removed += 1;
    } else {
      kept += 1;
    }

    messagesDeleted += plan.deletedMessages;
    attachmentsDeleted += plan.attachments.length;

    for (const attachment of plan.attachments) {
      for (const key of attachmentObjectKeys(attachment)) {
        try {
          await storage.delete(key);
          objectsDeleted += 1;
        } catch (error) {
          options.logger?.warn("conversation.attachment_object_failed", {
            conversationId: row.id,
            attachmentId: attachment.id,
            key,
            error,
          });
        }
      }
    }
  }

  if (removed > 0 || kept > 0) {
    options.logger?.info("conversation.removal", {
      removed,
      kept,
      messagesDeleted,
      attachmentsDeleted,
    });
  }

  return { removed, kept, messagesDeleted, attachmentsDeleted, objectsDeleted };
}

export interface ConversationJobsOptions {
  readonly boss: PgBoss;
  readonly sql: SQL;
  readonly storage: StorageClient;
  readonly logger?: Logger;
}

export interface ConversationJobs {
  stop(): Promise<void>;
}

/** Registers the conversation removal sweep (ADR 0011, 0012). */
export async function createConversationJobs(
  options: ConversationJobsOptions,
): Promise<ConversationJobs> {
  await ensurePgBossQueue(options.boss, CONVERSATION_REMOVAL_QUEUE);

  await options.boss.work(CONVERSATION_REMOVAL_QUEUE, async () => {
    await runConversationRemoval(options.sql, options.storage, {
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  });

  await options.boss.schedule(CONVERSATION_REMOVAL_QUEUE, CONVERSATION_REMOVAL_CRON, {});

  return {
    async stop() {
      await options.boss.offWork(CONVERSATION_REMOVAL_QUEUE);
    },
  };
}
