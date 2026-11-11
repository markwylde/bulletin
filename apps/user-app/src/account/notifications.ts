import {
  listNotifications,
  type NotificationEntry,
  unreadNotificationCount,
} from "@bulletin/domain/notifications";
import { canonicalUrl } from "@bulletin/domain/urls";
import { formatRelativeTime, type Locale, type Translator } from "@bulletin/i18n";
import type { SQL } from "bun";
import type { BreadcrumbItem } from "../theme/render.ts";

export interface NotificationsPageInput {
  readonly sql: SQL;
  readonly memberId: string;
  readonly sessionId: string | null;
  readonly locale: Locale;
  readonly translate: Translator;
  /** One-based; page size is fixed so the query is bounded. */
  readonly page?: number;
}

export interface NotificationRow {
  readonly id: string;
  readonly text: string;
  readonly href: string | null;
  readonly iso: string;
  readonly time: string;
  readonly unread: boolean;
  readonly unreadAttr: "true" | "false";
}

export interface NotificationSection {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly NotificationRow[];
}

export interface NotificationsPageData {
  readonly title: string;
  readonly memberId: string;
  readonly breadcrumbs: readonly BreadcrumbItem[];
  readonly viewModel: {
    readonly hasNotifications: boolean;
    readonly unreadCount: number;
    readonly readAllDisabled: boolean;
    readonly sections: readonly NotificationSection[];
    readonly pagination: {
      readonly page: number;
      readonly hasPrevious: boolean;
      readonly hasNext: boolean;
    };
  };
}

function relativeLabel(value: Date, now: Date, locale: Locale): string {
  const seconds = Math.round((value.getTime() - now.getTime()) / 1_000);
  const absolute = Math.abs(seconds);

  if (absolute < 60) {
    return formatRelativeTime(seconds, "second", locale);
  }

  if (absolute < 3_600) {
    return formatRelativeTime(Math.round(seconds / 60), "minute", locale);
  }

  if (absolute < 86_400) {
    return formatRelativeTime(Math.round(seconds / 3_600), "hour", locale);
  }

  return formatRelativeTime(Math.round(seconds / 86_400), "day", locale);
}

/** The localised one-line text for an entry; never includes any post body or quote. */
function notificationText(translate: Translator, entry: NotificationEntry): string {
  const actor = entry.actorName ?? translate("notifications.someone");
  const topic = entry.topicTitle ?? "";

  switch (entry.type) {
    case "topic.reply":
      return entry.count > 1
        ? translate("notification.text.topic.replyMany", { count: entry.count, topic })
        : translate("notification.text.topic.reply", { actor, topic });
    case "topic.created":
      return translate("notification.text.topic.created", { actor, topic });
    case "post.mention":
      return entry.count > 1
        ? translate("notification.text.post.mentionMany", { count: entry.count, topic })
        : translate("notification.text.post.mention", { actor, topic });
    case "post.quote":
      return entry.count > 1
        ? translate("notification.text.post.quoteMany", { count: entry.count, topic })
        : translate("notification.text.post.quote", { actor, topic });
    case "reaction.added":
      return entry.count > 1
        ? translate("notification.text.reaction.addedMany", { count: entry.count })
        : translate("notification.text.reaction.added", { actor });
    case "member.promoted":
      return translate("notification.text.member.promoted");
  }
}

function sectionKey(value: Date, dayStart: Date, weekStart: Date): "today" | "week" | "earlier" {
  if (value >= dayStart) {
    return "today";
  }

  return value >= weekStart ? "week" : "earlier";
}

/** "Notifications": the member's entries grouped by recency, plus the mark-all control. */
export const NOTIFICATIONS_PAGE_SIZE = 50;

export async function buildNotificationsPage(
  input: NotificationsPageInput,
): Promise<NotificationsPageData> {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageEntries = await listNotifications(input.sql, input.memberId, {
    limit: NOTIFICATIONS_PAGE_SIZE + 1,
    offset: (page - 1) * NOTIFICATIONS_PAGE_SIZE,
  });
  const entries = pageEntries.slice(0, NOTIFICATIONS_PAGE_SIZE);
  const unreadCount = await unreadNotificationCount(input.sql, input.memberId);
  const title = input.translate("notifications.title");
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const weekStart = new Date(dayStart.getTime() - 6 * 86_400_000);
  const sections = new Map<"today" | "week" | "earlier", NotificationRow[]>([
    ["today", []],
    ["week", []],
    ["earlier", []],
  ]);

  for (const entry of entries) {
    const key = sectionKey(entry.updatedAt, dayStart, weekStart);
    const href =
      entry.topicId !== null && entry.topicSlug !== null
        ? canonicalUrl(
            "topic",
            entry.topicId,
            entry.topicSlug,
            entry.postId === null ? {} : { postId: entry.postId },
          )
        : null;

    sections.get(key)?.push({
      id: entry.id,
      text: notificationText(input.translate, entry),
      href,
      iso: entry.updatedAt.toISOString(),
      time: relativeLabel(entry.updatedAt, now, input.locale),
      unread: !entry.read,
      unreadAttr: entry.read ? "false" : "true",
    });
  }

  const labels = {
    today: input.translate("notifications.section.today"),
    week: input.translate("notifications.section.week"),
    earlier: input.translate("notifications.section.earlier"),
  } as const;

  return {
    title,
    memberId: input.memberId,
    breadcrumbs: [
      { label: input.translate("account.title"), href: "/account" },
      { label: title, href: null },
    ],
    viewModel: {
      hasNotifications: entries.length > 0,
      unreadCount,
      readAllDisabled: unreadCount === 0,
      pagination: {
        page,
        hasPrevious: page > 1,
        hasNext: pageEntries.length > NOTIFICATIONS_PAGE_SIZE,
      },
      sections: (["today", "week", "earlier"] as const)
        .map((key) => ({ key, label: labels[key], entries: sections.get(key) ?? [] }))
        .filter((section) => section.entries.length > 0),
    },
  };
}
