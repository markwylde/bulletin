import { readUploadLimits } from "@bulletin/domain/attachments";
import {
  type ConversationFolder,
  type ConversationSummary,
  listConversations,
  readConversationForParticipant,
  readPmPolicy,
  searchConversations,
} from "@bulletin/domain/conversations";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import { type SafeHtml, safeHtml } from "@bulletin/templates";
import type { SQL } from "bun";
import { buildEditorView, type EditorView } from "../editor.ts";
import type { BreadcrumbItem } from "../theme/render.ts";
import { renderConversationMessages } from "./messages.ts";

export interface InboxPageInput {
  readonly sql: SQL;
  readonly memberId: string;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly folder: ConversationFolder;
  /** Present when the member searched their own conversations (task 2.3). */
  readonly query?: string;
}

export interface ConversationRowView {
  readonly id: string;
  readonly title: string;
  readonly href: string;
  readonly participants: string;
  readonly time: string;
  readonly iso: string;
  readonly unread: boolean;
  readonly unreadAttr: string;
  readonly unreadText: string;
}

export interface FolderTab {
  readonly key: ConversationFolder;
  readonly label: string;
  readonly href: string;
  readonly active: boolean;
  readonly count: number;
}

export interface InboxPageData {
  readonly title: string;
  readonly folder: ConversationFolder;
  readonly folders: readonly FolderTab[];
  readonly hasConversations: boolean;
  readonly conversations: readonly ConversationRowView[];
  readonly searchQuery: string;
  readonly canStart: boolean;
  readonly editor: EditorView | null;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: {
    readonly folder: ConversationFolder;
    readonly folders: readonly FolderTab[];
    readonly hasConversations: boolean;
    readonly conversations: readonly ConversationRowView[];
    readonly searchQuery: string;
    readonly canStart: boolean;
    readonly recipientLimit: number;
    readonly editor: EditorView | null;
    readonly folderLabel: string;
    readonly emptyText: string;
  };
}

export interface MessageView {
  readonly id: string;
  readonly authorName: string;
  readonly authorHref: string | null;
  readonly body: SafeHtml;
  readonly files: SafeHtml | null;
  readonly time: string;
  readonly iso: string;
}

export interface DetailParticipantView {
  readonly id: string;
  readonly name: string;
  readonly canRemove: boolean;
}

export interface ConversationPageData {
  readonly title: string;
  readonly id: string;
  readonly isStarter: boolean;
  readonly archived: boolean;
  readonly canReply: boolean;
  readonly messages: readonly MessageView[];
  readonly participants: readonly DetailParticipantView[];
  readonly editor: EditorView | null;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: {
    readonly conversationId: string;
    readonly isStarter: boolean;
    readonly archived: boolean;
    readonly canReply: boolean;
    readonly recipientLimit: number;
    readonly messages: readonly MessageView[];
    readonly participants: readonly DetailParticipantView[];
    readonly editor: EditorView | null;
  };
}

function folderLabel(folder: ConversationFolder, translate: Translator): string {
  switch (folder) {
    case "inbox":
      return translate("conversation.folder.inbox");
    case "sent":
      return translate("conversation.folder.sent");
    case "archive":
      return translate("conversation.folder.archive");
  }
}

function emptyText(folder: ConversationFolder, translate: Translator): string {
  switch (folder) {
    case "inbox":
      return translate("conversation.empty.inbox");
    case "sent":
      return translate("conversation.empty.sent");
    case "archive":
      return translate("conversation.empty.archive");
  }
}

function conversationHref(id: string): string {
  return `/conversations/${id}`;
}

function participantNames(
  participants: readonly ConversationSummary["participants"][number][],
  translate: Translator,
): string {
  return participants
    .map((participant) => participant.displayName ?? translate("member.deletedName"))
    .join(", ");
}

function dateFormatter(locale: Locale): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
}

function rowView(
  summary: ConversationSummary,
  locale: Locale,
  translate: Translator,
): ConversationRowView {
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(summary.lastMessageAt);

  return {
    id: summary.id,
    title: summary.title,
    href: conversationHref(summary.id),
    participants: participantNames(summary.participants, translate),
    time: date,
    iso: summary.lastMessageAt.toISOString(),
    unread: summary.unreadCount > 0,
    unreadAttr: summary.unreadCount > 0 ? "true" : "false",
    unreadText: translate("conversation.unread", { count: summary.unreadCount }),
  };
}

/**
 * The inbox, sent and archive lists. Sent is the conversations the member started; Archive is
 * the member's own archived bucket. All three are ordered by latest message (spec).
 */
export async function buildInboxPage(input: InboxPageInput): Promise<InboxPageData> {
  const lists = await listConversations(input.sql, input.memberId);
  const policy = await readPmPolicy(input.sql, input.memberId);
  const selectedLabel = folderLabel(input.folder, input.translate);
  const query = (input.query ?? "").trim();
  const searching = query !== "";

  const folders: FolderTab[] = (["inbox", "sent", "archive"] as const).map((key) => ({
    key,
    label: folderLabel(key, input.translate),
    href: `/conversations?folder=${key}`,
    active: key === input.folder && !searching,
    count: lists[key].length,
  }));
  const conversations = (
    searching
      ? await searchConversations(input.sql, input.memberId, query, input.locale)
      : lists[input.folder]
  ).map((summary) => rowView(summary, input.locale, input.translate));
  const editor =
    policy.canUse && input.folder !== "archive"
      ? await buildEditorView(input.sql, input.translate, {
          contextKey: `conversation:new`,
          mentions: true,
          attachments: false,
          name: "bodyMd",
          forumId: "",
          canUpload: false,
        })
      : null;

  return {
    title: input.translate("conversation.title"),
    folder: input.folder,
    folders,
    hasConversations: conversations.length > 0,
    conversations,
    searchQuery: query,
    canStart: policy.canUse,
    editor,
    breadcrumbs: [
      { label: input.translate("account.title"), href: "/account" },
      { label: input.translate("conversation.title"), href: null },
    ],
    viewModel: {
      folder: input.folder,
      folders,
      hasConversations: conversations.length > 0,
      conversations,
      searchQuery: query,
      canStart: policy.canUse && editor !== null,
      recipientLimit: policy.recipientLimit,
      editor,
      folderLabel: selectedLabel,
      emptyText: searching
        ? input.translate("conversation.empty.search")
        : emptyText(input.folder, input.translate),
    },
  };
}

/** One conversation as a current participant sees it; null means 404. */
export async function buildConversationPage(input: {
  readonly sql: SQL;
  readonly memberId: string;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly conversationId: string;
  /** False when the `attachments` flag is off: placeholders and uploads disappear. */
  readonly attachmentsEnabled?: boolean;
  readonly mentionsEnabled?: boolean;
}): Promise<ConversationPageData | null> {
  const detail = await readConversationForParticipant(
    input.sql,
    input.conversationId,
    input.memberId,
  );

  if (detail === null) {
    return null;
  }

  const policy = await readPmPolicy(input.sql, input.memberId);
  const attachmentsEnabled = input.attachmentsEnabled !== false;
  const limits = attachmentsEnabled ? await readUploadLimits(input.sql, input.memberId) : null;
  const canUpload =
    policy.canUse &&
    limits !== null &&
    limits.quotaBytes > 0 &&
    limits.perFileBytes > 0 &&
    limits.allowedTypes.length > 0;
  const date = dateFormatter(input.locale);
  const renderedMessages = await renderConversationMessages({
    sql: input.sql,
    conversationId: detail.id,
    memberId: input.memberId,
    messages: detail.messages,
    locale: input.locale,
    translate: input.translate,
    attachmentsEnabled,
    mentionsEnabled: input.mentionsEnabled !== false,
  });
  const messages: MessageView[] = renderedMessages.map((message) => ({
    id: message.id,
    authorName: message.authorName ?? input.translate("member.deletedName"),
    authorHref:
      message.authorName === null
        ? null
        : canonicalUrl("profile", message.authorId, message.authorName),
    body: safeHtml(message.bodyHtml),
    files: message.filesHtml === null ? null : safeHtml(message.filesHtml),
    time: date.format(message.createdAt),
    iso: message.createdAt.toISOString(),
  }));
  const participants: DetailParticipantView[] = detail.participants.map((participant) => ({
    id: participant.id,
    name: participant.displayName ?? input.translate("member.deletedName"),
    canRemove: detail.viewer.isStarter && participant.id !== input.memberId,
  }));
  const editor = policy.canUse
    ? await buildEditorView(input.sql, input.translate, {
        contextKey: `conversation:reply:${detail.id}`,
        mentions: true,
        attachments: attachmentsEnabled,
        name: "bodyMd",
        forumId: "",
        conversationId: detail.id,
        canUpload,
      })
    : null;

  return {
    title: detail.title,
    id: detail.id,
    isStarter: detail.viewer.isStarter,
    archived: detail.viewer.folder === "archive",
    canReply: policy.canUse,
    messages,
    participants,
    editor,
    breadcrumbs: [
      { label: input.translate("conversation.title"), href: "/conversations" },
      { label: detail.title, href: null },
    ],
    viewModel: {
      conversationId: detail.id,
      isStarter: detail.viewer.isStarter,
      archived: detail.viewer.folder === "archive",
      canReply: policy.canUse,
      recipientLimit: policy.recipientLimit,
      messages,
      participants,
      editor,
    },
  };
}
