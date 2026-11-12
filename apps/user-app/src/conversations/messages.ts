import {
  ensureCurrentRendering,
  type ReplaceWords,
  resolveQuotePlaceholders,
} from "@bulletin/content";
import { readConversationMessageAttachments } from "@bulletin/domain/attachments";
import { listEmbedProviders, loadQuoteSnapshot } from "@bulletin/domain/content";
import {
  type ConversationMessage,
  isConversationMessageReadable,
} from "@bulletin/domain/conversations";
import type { Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import { renderPostAttachments } from "../topics/attachments.ts";

export interface RenderedConversationMessage {
  readonly id: string;
  readonly authorId: string;
  readonly authorName: string | null;
  readonly bodyHtml: string;
  readonly filesHtml: string | null;
  readonly createdAt: Date;
}

export interface RenderConversationMessagesInput {
  readonly sql: SQL;
  readonly conversationId: string;
  readonly memberId: string;
  readonly messages: readonly ConversationMessage[];
  readonly locale: Locale;
  readonly translate: Translator;
  readonly attachmentsEnabled: boolean;
  readonly mentionsEnabled: boolean;
  readonly replaceWords?: ReplaceWords;
}

/**
 * The one authorised message renderer used by SSR and by the live-reply response. Stored HTML
 * is re-sanitised when its versions are stale (ADR 0007), quotes are resolved against the same
 * conversation, and attachment placeholders become a real file list.
 */
export async function renderConversationMessages(
  input: RenderConversationMessagesInput,
): Promise<readonly RenderedConversationMessage[]> {
  if (input.messages.length === 0) {
    return [];
  }

  const [embedProviders, attachmentMap] = await Promise.all([
    listEmbedProviders(input.sql),
    readConversationMessageAttachments(
      input.sql,
      input.messages.map((message) => message.id),
    ),
  ]);
  const resolver = {
    loadSnapshot: (snapshotId: string) => loadQuoteSnapshot(input.sql, snapshotId),
    async canRead(
      ref: { readonly kind: string; readonly id: string },
      viewerId: string | null,
    ): Promise<boolean> {
      return (
        ref.kind === "message" &&
        viewerId !== null &&
        (await isConversationMessageReadable(input.sql, input.conversationId, ref.id, viewerId))
      );
    },
    sourceUrl: (): string | null => null,
  };

  return Promise.all(
    input.messages.map(async (message) => {
      const unfilteredSource = message.bodyHtmlUnfiltered !== null;
      const current = await ensureCurrentRendering(
        {
          bodyHtml: message.bodyHtmlUnfiltered ?? message.bodyHtml,
          bodyText: message.bodyText,
          renderVersion: message.renderVersion,
          sanitiserVersion: message.sanitiserVersion,
        },
        {
          profile: "post",
          embedProviders,
          mentions: input.mentionsEnabled,
          ...(input.replaceWords === undefined ? {} : { replaceWords: input.replaceWords }),
          // The stored unfiltered HTML always needs the current replacement list applied.
          ...(unfilteredSource ? { versions: { renderVersion: -1, sanitiserVersion: -1 } } : {}),
        },
      );
      const bodyHtml = await resolveQuotePlaceholders(current.bodyHtml, {
        resolver,
        viewerId: input.memberId,
        translate: input.translate,
      });
      const attachments = renderPostAttachments({
        postId: message.id,
        ownerKind: "message",
        html: bodyHtml,
        attachments: attachmentMap.get(message.id) ?? [],
        locale: input.locale,
        translate: input.translate,
        canRemove: false,
        enabled: input.attachmentsEnabled,
      });

      return {
        id: message.id,
        authorId: message.authorId,
        authorName: message.authorName,
        bodyHtml: attachments.bodyHtml,
        filesHtml: attachments.files === null ? null : String(attachments.files),
        createdAt: message.createdAt,
      };
    }),
  );
}
