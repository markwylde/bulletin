import { ensureCurrentRendering } from "@bulletin/content";
import { type ForumRecord, listVisibleForums } from "@bulletin/domain/forums";
import {
  announcementAudienceClass,
  CapabilityView,
  can,
  filterVisibleAnnouncements,
  GUEST_PRINCIPAL,
  globalAnnouncements,
  loadAnnouncements,
  loadForumTree,
  loadPermissionSnapshot,
  nextAnnouncementTransitionMs,
} from "@bulletin/domain/permissions";
import { canonicalUrl } from "@bulletin/domain/urls";
import type { Locale, Translator } from "@bulletin/i18n";
import { escapeHtml, type SafeHtml, safeHtml } from "@bulletin/templates";
import type { SQL } from "bun";
import type { UserAppSessionContext } from "../session.ts";
import { forumCapabilityDeps } from "./capability.ts";

export interface BoardIndexLink {
  readonly id: string;
  readonly title: string;
  readonly href: string;
}

export interface BoardIndexLastPost {
  readonly date: string;
  readonly memberName: string | null;
}

export interface BoardIndexRedirect {
  readonly url: string;
  readonly count: number;
  readonly clicks: string;
}

export interface BoardIndexForum extends BoardIndexLink {
  readonly description: string;
  readonly topicCount: string;
  readonly postCount: string;
  readonly subforums: readonly BoardIndexLink[];
  readonly lastPost: BoardIndexLastPost | null;
  readonly redirect: BoardIndexRedirect | null;
}

export interface BoardIndexCategory extends BoardIndexLink {
  readonly description: string;
  readonly forums: readonly BoardIndexForum[];
}

export interface BoardIndexAnnouncement {
  readonly id: string;
  readonly title: string;
  readonly body: SafeHtml;
  readonly dismissible: boolean;
  readonly version: number;
}

export interface BoardIndexView {
  readonly categories: readonly BoardIndexCategory[];
  readonly rootForums: readonly BoardIndexForum[];
  readonly announcements: readonly BoardIndexAnnouncement[];
  readonly flags: Readonly<Record<string, boolean>>;
}

export interface BoardIndexInput {
  readonly sql: SQL;
  readonly locale: Locale;
  readonly translate: Translator;
  readonly session: UserAppSessionContext | null;
  /** The `announcements` flag; direct builder tests default to on. */
  readonly announcementsEnabled?: boolean;
  /** Test seam for announcement transitions. */
  readonly now?: Date;
}

export interface BoardIndexData {
  readonly viewModel: BoardIndexView;
  readonly visibilityKey: string;
  readonly hasUnlockGrant: boolean;
  readonly ttlMs: number | null;
}

function forumHref(forum: ForumRecord): string {
  return canonicalUrl("forum", forum.id, forum.slug);
}

function formatDate(locale: Locale, value: Date): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(value);
}

/**
 * Builds the board index view model. Every decision goes through `can()` and the shared
 * capability view, so a hidden forum and its sub-forums never reach the HTML (ADR 0005).
 */
export async function buildBoardIndex(input: BoardIndexInput): Promise<BoardIndexData> {
  const tree = await loadForumTree(input.sql);
  const principal = input.session?.memberId ?? GUEST_PRINCIPAL;
  const sessionId = input.session?.sessionId ?? null;
  const snapshot = await loadPermissionSnapshot(input.sql, principal, { tree, sessionId });
  const view = new CapabilityView({
    ...snapshot,
    deps: forumCapabilityDeps(tree),
    view: "board-index",
  });
  const rows = await listVisibleForums(input.sql, view);
  const readable = new Map<string, boolean>();

  for (const row of rows) {
    const answer = await can(input.sql, principal, "read", {
      forumId: row.id,
      tree,
      sessionId,
      snapshot,
    });
    view.track(row.id, "read", answer);
    readable.set(row.id, answer);
  }

  const link = (forum: ForumRecord): BoardIndexLink => ({
    id: forum.id,
    title: forum.title,
    href: forumHref(forum),
  });

  const forumView = (forum: ForumRecord): BoardIndexForum => {
    const canRead = readable.get(forum.id) === true;
    const lastPost =
      canRead && forum.lastPostAt !== null
        ? {
            date: formatDate(input.locale, forum.lastPostAt),
            memberName: forum.lastPostMemberName,
          }
        : null;
    const redirect =
      forum.type === "redirect" && forum.redirectUrl !== null
        ? {
            url: forum.redirectUrl,
            count: forum.redirectClicks,
            clicks: input.translate("index.redirectClicks", { count: forum.redirectClicks }),
          }
        : null;

    return {
      ...link(forum),
      description: forum.description,
      topicCount: input.translate("index.topicCount", { count: forum.topicCount }),
      postCount: input.translate("index.postCount", { count: forum.postCount }),
      subforums: rows
        .filter((candidate) => candidate.parentId === forum.id && candidate.type !== "category")
        .map(link),
      lastPost,
      redirect,
    };
  };

  const rootForums = rows
    .filter((row) => row.parentId === null && row.type !== "category")
    .map(forumView);
  const now = input.now ?? new Date();
  const announcementsEnabled = input.announcementsEnabled !== false;
  const allAnnouncements = announcementsEnabled ? await loadAnnouncements(input.sql, now) : [];
  const announcements = await filterVisibleAnnouncements(input.sql, principal, allAnnouncements, {
    tree,
    snapshot,
  });
  const notices = announcementsEnabled ? globalAnnouncements(announcements, now) : [];
  const noticeViews = await Promise.all(
    notices.map(async (announcement) => ({
      announcement,
      rendered: await ensureCurrentRendering(
        {
          bodyHtml: announcement.bodyHtml,
          bodyText: announcement.bodyText,
          renderVersion: announcement.renderVersion,
          sanitiserVersion: announcement.sanitiserVersion,
        },
        { profile: "rules" },
      ),
    })),
  );
  const audience = announcementAudienceClass(announcements, snapshot.groupIds, now);
  const categories = rows
    .filter((row) => row.type === "category")
    .map((category) => {
      const forums = rows
        .filter((row) => row.parentId === category.id && row.type !== "category")
        .map(forumView);

      return {
        ...link(category),
        description: category.description,
        forums,
      };
    })
    .filter((category) => category.forums.length > 0);

  return {
    viewModel: {
      categories,
      rootForums,
      announcements: noticeViews.map(({ announcement, rendered }) => ({
        id: announcement.id,
        title: announcement.title,
        body: safeHtml(
          rendered.bodyHtml.trim() === ""
            ? `<p>${escapeHtml(announcement.body)}</p>`
            : rendered.bodyHtml,
        ),
        dismissible: announcement.dismissible,
        version: announcement.version,
      })),
      flags: { announcements: announcementsEnabled },
    },
    visibilityKey: `${view.visibilityKey()}|audience:${audience}`,
    hasUnlockGrant: view.hasUnlockGrant,
    ttlMs: announcementsEnabled ? nextAnnouncementTransitionMs(announcements, now) : null,
  };
}
