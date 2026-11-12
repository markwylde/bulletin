import { readConversationMessagesAfter, readParticipation } from "@bulletin/domain/conversations";
import type { Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import { type RenderedConversationMessage, renderConversationMessages } from "./messages.ts";

/** One page of live messages; `hasMore` tells the client to continue from the last id. */
export const LIVE_MESSAGE_BATCH = 100;

export interface LiveMessagesInput {
  readonly sql: SQL;
  readonly conversationId: string;
  readonly memberId: string;
  readonly after: string;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly attachmentsEnabled: boolean;
  readonly mentionsEnabled: boolean;
}

export interface LiveMessagesResult {
  readonly messages: readonly RenderedConversationMessage[];
  readonly hasMore: boolean;
}

/** Null means the caller is not a current participant (404). */
export async function loadLiveConversationMessages(
  input: LiveMessagesInput,
): Promise<LiveMessagesResult | null> {
  if ((await readParticipation(input.sql, input.conversationId, input.memberId)) === null) {
    return null;
  }

  // Read one extra row so the client can drain a backlog larger than one batch without
  // advancing its cursor past anything it has not rendered (review finding P2).
  const rows = await readConversationMessagesAfter(
    input.sql,
    input.conversationId,
    input.memberId,
    input.after,
    LIVE_MESSAGE_BATCH + 1,
  );
  const page = rows.slice(0, LIVE_MESSAGE_BATCH);
  const messages = await renderConversationMessages({
    sql: input.sql,
    conversationId: input.conversationId,
    memberId: input.memberId,
    messages: page,
    locale: input.locale,
    translate: input.translate,
    attachmentsEnabled: input.attachmentsEnabled,
    mentionsEnabled: input.mentionsEnabled,
  });

  return { messages, hasMore: rows.length > LIVE_MESSAGE_BATCH };
}
