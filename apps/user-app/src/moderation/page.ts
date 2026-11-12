import { listApprovalQueue, type ModerationQueueItem } from "@bulletin/domain/moderation";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import type { BreadcrumbItem } from "../theme/render.ts";

export interface ModerationQueueRow {
  readonly postId: string;
  readonly kind: "topic" | "post";
  readonly title: string;
  readonly href: string;
  readonly forumTitle: string;
  readonly author: string;
  readonly reason: string;
  readonly preview: string;
  readonly createdAt: string;
}

export interface ModerationQueuePageData {
  readonly title: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: {
    readonly total: number;
    readonly hasItems: boolean;
    readonly items: readonly ModerationQueueRow[];
    readonly flags: Readonly<Record<string, boolean>>;
  };
}

function reasonLabel(translate: Translator, reason: string | null): string {
  switch (reason) {
    case "new_member":
      return translate("moderation.holdReason.new_member");
    case "group":
      return translate("moderation.holdReason.group");
    case "forum":
      return translate("moderation.holdReason.forum");
    case "warning":
      return translate("moderation.holdReason.warning");
    case "filter":
      return translate("moderation.holdReason.filter");
    default:
      return translate("moderation.holdReason.other");
  }
}

function formatDate(locale: Locale, value: Date): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function row(locale: Locale, translate: Translator, item: ModerationQueueItem): ModerationQueueRow {
  return {
    postId: item.postId,
    kind: item.kind,
    title: item.topicTitle,
    href: canonicalUrl("topic", item.topicId, item.topicSlug, { postId: item.postId }),
    forumTitle: item.forumTitle,
    author: item.authorName ?? translate("member.deletedName"),
    reason: reasonLabel(translate, item.reason),
    preview: item.preview,
    createdAt: formatDate(locale, item.createdAt),
  };
}

/** The moderator queue page; null means the viewer cannot approve anywhere (403). */
export async function buildModerationQueuePage(input: {
  readonly sql: SQL;
  readonly memberId: string;
  readonly sessionId: string | null;
  readonly locale: Locale;
  readonly translate: Translator;
}): Promise<ModerationQueuePageData | null> {
  const queue = await listApprovalQueue(input.sql, {
    actorId: input.memberId,
    limit: 100,
    offset: 0,
    sessionId: input.sessionId,
  });

  if (queue.forums.length === 0) {
    return null;
  }

  return {
    title: input.translate("moderation.queue.title"),
    breadcrumbs: [{ label: input.translate("moderation.queue.title"), href: null }],
    viewModel: {
      total: queue.total,
      hasItems: queue.items.length > 0,
      items: queue.items.map((item) => row(input.locale, input.translate, item)),
      flags: {},
    },
  };
}
