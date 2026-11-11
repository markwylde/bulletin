import { saveContent } from "@bulletin/content";
import type { SQL } from "bun";
import { syncConversationMessageAttachments } from "../attachments/index.ts";
import { loadContentRenderDependencies } from "../content/rendering.ts";
import { emit } from "../events/outbox.ts";
import {
  conversationParticipantMutation,
  conversationReplyMutation,
} from "../mutations/conversations.ts";
import { runMutation } from "../mutations/index.ts";
import {
  countActiveParticipants,
  countConversationMessages,
  createConversationQuotePipeline,
  insertConversationMessage,
  inviteParticipant,
  lockConversationForWrite,
  markParticipantLeft,
  markParticipantRemoved,
  memberCanUsePms,
  memberIsReachable,
  readMemberSearchConfig,
  readParticipantState,
  readParticipation,
  readPmPolicy,
  recipientIgnores,
  recordConversationReply,
} from "./repository.ts";

const MEMBER_ID = /^[1-9]\d{0,18}$/;

export type ReplyFailure = {
  readonly ok: false;
  readonly code: "not_found" | "pm_disabled" | "invalid_body";
};

export type ConversationParticipantFailure =
  | {
      readonly ok: false;
      readonly code:
        | "not_found"
        | "forbidden"
        | "pm_disabled"
        | "recipient_unavailable"
        | "already_participant"
        | "invite_blocked"
        | "cannot_remove_self";
    }
  | { readonly ok: false; readonly code: "recipient_limit"; readonly limit: number };

export type ReplyOutcome =
  | {
      readonly ok: true;
      readonly result: { readonly conversationId: string; readonly messageId: string };
    }
  | ReplyFailure;

export type ParticipantOutcome = { readonly ok: true } | ConversationParticipantFailure;

function validBody(value: string): string | null {
  return value.trim() === "" ? null : value;
}

/**
 * Replies as a current participant. A former participant, an unknown ID and an unauthorised
 * caller all look the same (`not_found`); banned or PM-disabled members are refused.
 */
export async function replyToConversation(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly conversationId: string;
    readonly bodyMd: string;
  },
): Promise<ReplyOutcome> {
  const bodyMd = validBody(input.bodyMd);

  if (bodyMd === null) {
    return { ok: false, code: "invalid_body" };
  }

  const initial = await readParticipation(sql, input.conversationId, input.actorId);

  if (initial === null) {
    return { ok: false, code: "not_found" };
  }

  if (!(await memberCanUsePms(sql, input.actorId))) {
    return { ok: false, code: "pm_disabled" };
  }

  return runMutation<{ readonly conversationId: string; readonly authorId: string }, ReplyOutcome>({
    sql,
    mutation: conversationReplyMutation,
    input: { conversationId: input.conversationId, authorId: input.actorId },
    apply: async (tx) => {
      if (!(await lockConversationForWrite(tx, input.conversationId))) {
        return { ok: false, code: "not_found" };
      }

      if ((await readParticipation(tx, input.conversationId, input.actorId)) === null) {
        return { ok: false, code: "not_found" };
      }

      if (!(await memberCanUsePms(tx, input.actorId))) {
        return { ok: false, code: "pm_disabled" };
      }

      const [dependencies, lang] = await Promise.all([
        loadContentRenderDependencies(tx),
        readMemberSearchConfig(tx, input.actorId),
      ]);
      const rendered = await saveContent(bodyMd, {
        profile: "post",
        context: { kind: "conversation_message", conversationId: input.conversationId },
        authorId: input.actorId,
        emoticons: dependencies.emoticons,
        mentions: dependencies.mentions,
        embeds: dependencies.embeds,
        quotes: createConversationQuotePipeline(tx, input.conversationId),
      });
      const message = await insertConversationMessage(tx, {
        conversationId: input.conversationId,
        authorId: input.actorId,
        bodyMd: rendered.bodyMd,
        bodyHtml: rendered.bodyHtml,
        bodyText: rendered.bodyText,
        lang,
      });

      await syncConversationMessageAttachments(tx, {
        messageId: message.id,
        conversationId: input.conversationId,
        authorId: input.actorId,
        bodyHtml: rendered.bodyHtml,
      });

      await recordConversationReply(tx, {
        conversationId: input.conversationId,
        messageId: message.id,
        authorId: input.actorId,
        at: message.createdAt,
      });

      await emit(tx, {
        type: "pm.sent",
        aggregateId: BigInt(input.conversationId),
        aggregateVersion: await countConversationMessages(tx, input.conversationId),
        payloadIds: {
          conversationId: BigInt(input.conversationId),
          messageId: BigInt(message.id),
          senderId: BigInt(input.actorId),
        },
      });

      return {
        ok: true,
        result: { conversationId: input.conversationId, messageId: message.id },
      };
    },
  });
}

/**
 * The starter adds one participant, within the group recipient cap. The new participant sees
 * the full history; former participants who left with "block re-invites" are refused.
 */
export async function inviteConversationParticipant(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly conversationId: string;
    readonly memberId: string;
  },
): Promise<ParticipantOutcome> {
  if (!MEMBER_ID.test(input.memberId)) {
    return { ok: false, code: "recipient_unavailable" };
  }

  return runMutation<
    { readonly conversationId: string; readonly memberId: string; readonly action: string },
    ParticipantOutcome
  >({
    sql,
    mutation: conversationParticipantMutation,
    input: {
      conversationId: input.conversationId,
      memberId: input.memberId,
      action: "invite",
    },
    apply: async (tx) => {
      if (!(await lockConversationForWrite(tx, input.conversationId))) {
        return { ok: false, code: "not_found" };
      }

      const actor = await readParticipation(tx, input.conversationId, input.actorId);

      if (actor === null) {
        return { ok: false, code: "not_found" };
      }

      if (!actor.isStarter) {
        return { ok: false, code: "forbidden" };
      }

      if (!(await memberCanUsePms(tx, input.actorId))) {
        return { ok: false, code: "pm_disabled" };
      }

      const existing = await readParticipantState(tx, input.conversationId, input.memberId);

      if (existing?.state === "active") {
        return { ok: false, code: "already_participant" };
      }

      if (existing?.blockReinvite === true) {
        return { ok: false, code: "invite_blocked" };
      }

      const policy = await readPmPolicy(tx, input.actorId);
      const recipients = (await countActiveParticipants(tx, input.conversationId)) - 1;

      if (recipients + 1 > policy.recipientLimit) {
        return { ok: false, code: "recipient_limit", limit: policy.recipientLimit };
      }

      if (
        !(await memberIsReachable(tx, input.memberId)) ||
        !(await memberCanUsePms(tx, input.memberId)) ||
        (await recipientIgnores(tx, input.memberId, input.actorId))
      ) {
        return { ok: false, code: "recipient_unavailable" };
      }

      await inviteParticipant(tx, input.conversationId, input.memberId);
      return { ok: true };
    },
  });
}

/** The starter removes a participant; removal ends all access to the history. */
export async function removeConversationParticipant(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly conversationId: string;
    readonly memberId: string;
  },
): Promise<ParticipantOutcome> {
  if (!MEMBER_ID.test(input.memberId)) {
    return { ok: false, code: "not_found" };
  }

  return runMutation<
    { readonly conversationId: string; readonly memberId: string; readonly action: string },
    ParticipantOutcome
  >({
    sql,
    mutation: conversationParticipantMutation,
    input: {
      conversationId: input.conversationId,
      memberId: input.memberId,
      action: "remove",
    },
    apply: async (tx) => {
      if (!(await lockConversationForWrite(tx, input.conversationId))) {
        return { ok: false, code: "not_found" };
      }

      const actor = await readParticipation(tx, input.conversationId, input.actorId);

      if (actor === null) {
        return { ok: false, code: "not_found" };
      }

      if (!actor.isStarter) {
        return { ok: false, code: "forbidden" };
      }

      if (input.memberId === input.actorId) {
        return { ok: false, code: "cannot_remove_self" };
      }

      return (await markParticipantRemoved(tx, input.conversationId, input.memberId))
        ? { ok: true }
        : { ok: false, code: "not_found" };
    },
  });
}

/** Any participant leaves; leaving frees a quota slot and ends access, including history. */
export async function leaveConversation(
  sql: SQL,
  input: {
    readonly actorId: string;
    readonly conversationId: string;
    readonly blockReinvite?: boolean;
  },
): Promise<ParticipantOutcome> {
  return runMutation<
    { readonly conversationId: string; readonly memberId: string; readonly action: string },
    ParticipantOutcome
  >({
    sql,
    mutation: conversationParticipantMutation,
    input: {
      conversationId: input.conversationId,
      memberId: input.actorId,
      action: "leave",
    },
    apply: async (tx) => {
      if (!(await lockConversationForWrite(tx, input.conversationId))) {
        return { ok: false, code: "not_found" };
      }

      if ((await readParticipation(tx, input.conversationId, input.actorId)) === null) {
        return { ok: false, code: "not_found" };
      }

      return (await markParticipantLeft(
        tx,
        input.conversationId,
        input.actorId,
        input.blockReinvite === true,
      ))
        ? { ok: true }
        : { ok: false, code: "not_found" };
    },
  });
}
