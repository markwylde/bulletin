import { saveContent } from "@bulletin/content";
import type { SQL } from "bun";
import { loadContentRenderDependencies } from "../content/rendering.ts";
import { emit } from "../events/outbox.ts";
import { conversationStartMutation } from "../mutations/conversations.ts";
import { runMutation } from "../mutations/index.ts";
import {
  insertConversation,
  insertConversationMessage,
  insertParticipant,
  lockMemberForStart,
  memberCanUsePms,
  memberIsReachable,
  readPmPolicy,
  readStartUsage,
  recipientIgnores,
  touchConversation,
} from "./repository.ts";

export * from "./repository.ts";

const MEMBER_ID = /^[1-9]\d{0,18}$/;
const TITLE_MIN = 3;
const TITLE_MAX = 150;

export interface StartConversationInput {
  readonly actorId: string;
  readonly title: string;
  readonly bodyMd: string;
  /** Recipients other than the starter; duplicates and the starter are ignored. */
  readonly recipientIds: readonly string[];
}

export interface StartConversationResult {
  readonly conversationId: string;
  readonly messageId: string;
}

export type StartConversationFailure =
  | {
      readonly ok: false;
      readonly code:
        | "invalid_title"
        | "invalid_body"
        | "no_recipients"
        | "pm_disabled"
        | "recipient_unavailable";
    }
  | { readonly ok: false; readonly code: "recipient_limit"; readonly limit: number }
  | {
      readonly ok: false;
      readonly code: "daily_limit";
      readonly limit: number;
      readonly retryAfterSeconds: number;
    }
  | { readonly ok: false; readonly code: "quota_reached"; readonly quota: number };

export type StartConversationOutcome =
  | { readonly ok: true; readonly result: StartConversationResult }
  | StartConversationFailure;

function validTitle(value: string): string | null {
  const title = value.trim();
  return title.length >= TITLE_MIN && title.length <= TITLE_MAX ? title : null;
}

function secondsUntil(resetsAt: Date): number {
  return Math.max(1, Math.ceil((resetsAt.getTime() - Date.now()) / 1_000));
}

/**
 * Starts a conversation with its first message, in one transaction (design, ADR 0011).
 *
 * Every rejection happens before the first insert, so a failed start leaves no rows and no
 * event. Recipients who cannot use PMs or who ignore the starter all get the same generic
 * `recipient_unavailable`, which also avoids revealing whether a member exists.
 */
export async function startConversation(
  sql: SQL,
  input: StartConversationInput,
): Promise<StartConversationOutcome> {
  const title = validTitle(input.title);

  if (title === null) {
    return { ok: false, code: "invalid_title" };
  }

  if (input.bodyMd.trim() === "") {
    return { ok: false, code: "invalid_body" };
  }

  const recipients = [...new Set(input.recipientIds)].filter(
    (memberId) => memberId !== input.actorId,
  );

  if (recipients.length === 0) {
    return { ok: false, code: "no_recipients" };
  }

  if (recipients.some((memberId) => !MEMBER_ID.test(memberId))) {
    return { ok: false, code: "recipient_unavailable" };
  }

  const initialPolicy = await readPmPolicy(sql, input.actorId);

  if (!initialPolicy.canUse) {
    return { ok: false, code: "pm_disabled" };
  }

  if (recipients.length > initialPolicy.recipientLimit) {
    return { ok: false, code: "recipient_limit", limit: initialPolicy.recipientLimit };
  }

  return runMutation<{ readonly starterId: string }, StartConversationOutcome>({
    sql,
    mutation: conversationStartMutation,
    input: { starterId: input.actorId },
    apply: async (tx) => {
      if (!(await lockMemberForStart(tx, input.actorId))) {
        return { ok: false, code: "pm_disabled" };
      }

      const policy = await readPmPolicy(tx, input.actorId);

      if (!policy.canUse) {
        return { ok: false, code: "pm_disabled" };
      }

      if (recipients.length > policy.recipientLimit) {
        return { ok: false, code: "recipient_limit", limit: policy.recipientLimit };
      }

      for (const recipientId of recipients) {
        if (
          !(await memberIsReachable(tx, recipientId)) ||
          !(await memberCanUsePms(tx, recipientId)) ||
          (await recipientIgnores(tx, recipientId, input.actorId))
        ) {
          return { ok: false, code: "recipient_unavailable" };
        }
      }

      const usage = await readStartUsage(tx, input.actorId);

      if (policy.quota > 0 && usage.active >= policy.quota) {
        return { ok: false, code: "quota_reached", quota: policy.quota };
      }

      if (policy.dailyLimit > 0 && usage.startedToday >= policy.dailyLimit) {
        return {
          ok: false,
          code: "daily_limit",
          limit: policy.dailyLimit,
          retryAfterSeconds: secondsUntil(usage.resetsAt),
        };
      }

      const conversation = await insertConversation(tx, {
        title,
        starterId: input.actorId,
      });
      const dependencies = await loadContentRenderDependencies(tx);
      const rendered = await saveContent(input.bodyMd, {
        profile: "post",
        context: { kind: "conversation_message", conversationId: conversation.id },
        authorId: input.actorId,
        emoticons: dependencies.emoticons,
        mentions: dependencies.mentions,
        embeds: dependencies.embeds,
      });

      for (const memberId of [input.actorId, ...recipients]) {
        await insertParticipant(tx, { conversationId: conversation.id, memberId });
      }

      const message = await insertConversationMessage(tx, {
        conversationId: conversation.id,
        authorId: input.actorId,
        bodyMd: rendered.bodyMd,
        bodyHtml: rendered.bodyHtml,
        bodyText: rendered.bodyText,
      });

      await touchConversation(tx, conversation.id, message.createdAt);

      await emit(tx, {
        type: "pm.sent",
        aggregateId: BigInt(conversation.id),
        aggregateVersion: 1n,
        payloadIds: {
          conversationId: BigInt(conversation.id),
          messageId: BigInt(message.id),
          senderId: BigInt(input.actorId),
        },
      });

      return { ok: true, result: { conversationId: conversation.id, messageId: message.id } };
    },
  });
}
